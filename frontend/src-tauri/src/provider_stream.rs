//! Incremental normalization for provider server-sent event streams.
//!
//! Input can be split at any byte boundary. Unknown future OpenAI or Anthropic event types are
//! surfaced as warnings instead of crashing or disappearing; malformed JSON, mismatched SSE event
//! labels, unbounded frames, and incomplete terminal sequences fail closed.

use crate::model_provider::{normalized_usage, NormalizedUsage, ProviderError, RemoteProviderId};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const MAX_PENDING_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum NormalizedStreamEvent {
    MessageStart {
        provider: RemoteProviderId,
        response_id: String,
    },
    TextDelta {
        text: String,
    },
    Usage {
        usage: NormalizedUsage,
    },
    Finish {
        status: String,
    },
    ProviderWarning {
        event_type: String,
    },
    ProviderError {
        code: Option<String>,
    },
    StreamEnd,
}

#[derive(Default)]
pub struct OpenAiSseDecoder {
    frames: SseFrameDecoder,
}

#[derive(Default)]
pub struct AnthropicSseDecoder {
    frames: SseFrameDecoder,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
}

#[derive(Default)]
struct SseFrameDecoder {
    pending: Vec<u8>,
}

impl OpenAiSseDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<NormalizedStreamEvent>, ProviderError> {
        let mut events = Vec::new();
        for event in self.frames.push(bytes)? {
            events.extend(normalize_openai_event(event)?);
        }
        Ok(events)
    }

    pub fn finish(self) -> Result<(), ProviderError> {
        self.frames.finish()
    }
}

impl AnthropicSseDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<NormalizedStreamEvent>, ProviderError> {
        let mut events = Vec::new();
        for event in self.frames.push(bytes)? {
            events.extend(normalize_anthropic_event(
                &mut self.input_tokens,
                &mut self.output_tokens,
                event,
            )?);
        }
        Ok(events)
    }

    pub fn finish(self) -> Result<(), ProviderError> {
        self.frames.finish()
    }
}

impl SseFrameDecoder {
    fn push(&mut self, bytes: &[u8]) -> Result<Vec<SseEvent>, ProviderError> {
        if self.pending.len() + bytes.len() > MAX_PENDING_BYTES {
            return Err(ProviderError::ResponseTooLarge);
        }
        self.pending.extend_from_slice(bytes);
        let mut events = Vec::new();
        while let Some((end, delimiter_length)) = frame_end(&self.pending) {
            let frame = self.pending.drain(..end).collect::<Vec<_>>();
            self.pending.drain(..delimiter_length);
            if let Some(event) = parse_sse_frame(&frame)? {
                events.push(event);
            }
        }
        Ok(events)
    }

    fn finish(self) -> Result<(), ProviderError> {
        self.pending
            .iter()
            .all(u8::is_ascii_whitespace)
            .then_some(())
            .ok_or(ProviderError::MalformedResponse)
    }
}

fn frame_end(bytes: &[u8]) -> Option<(usize, usize)> {
    let lf = bytes.windows(2).position(|window| window == b"\n\n");
    let crlf = bytes.windows(4).position(|window| window == b"\r\n\r\n");
    match (lf, crlf) {
        (Some(left), Some(right)) if left < right => Some((left, 2)),
        (Some(_), Some(right)) => Some((right, 4)),
        (Some(left), None) => Some((left, 2)),
        (None, Some(right)) => Some((right, 4)),
        (None, None) => None,
    }
}

struct SseEvent {
    label: Option<String>,
    data: String,
}

fn parse_sse_frame(frame: &[u8]) -> Result<Option<SseEvent>, ProviderError> {
    let frame = std::str::from_utf8(frame).map_err(|_| ProviderError::MalformedResponse)?;
    let mut label = None;
    let mut data = Vec::new();
    for raw_line in frame.lines() {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "event" => label = Some(value.to_owned()),
            "data" => data.push(value),
            _ => {}
        }
    }
    if data.is_empty() {
        return Ok(None);
    }
    Ok(Some(SseEvent {
        label,
        data: data.join("\n"),
    }))
}

fn normalize_openai_event(event: SseEvent) -> Result<Vec<NormalizedStreamEvent>, ProviderError> {
    if event.data == "[DONE]" {
        return Ok(vec![NormalizedStreamEvent::StreamEnd]);
    }
    let value: Value =
        serde_json::from_str(&event.data).map_err(|_| ProviderError::MalformedResponse)?;
    let event_type = value
        .get("type")
        .and_then(Value::as_str)
        .filter(|kind| !kind.is_empty())
        .ok_or(ProviderError::MalformedResponse)?;
    if event
        .label
        .as_deref()
        .is_some_and(|label| label != event_type)
    {
        return Err(ProviderError::MalformedResponse);
    }
    match event_type {
        "response.created" => {
            let response_id = value
                .get("response")
                .and_then(|response| response.get("id"))
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or(ProviderError::MalformedResponse)?;
            Ok(vec![NormalizedStreamEvent::MessageStart {
                provider: RemoteProviderId::OpenAi,
                response_id: response_id.to_owned(),
            }])
        }
        "response.output_text.delta" => {
            let text = value
                .get("delta")
                .and_then(Value::as_str)
                .ok_or(ProviderError::MalformedResponse)?;
            Ok(vec![NormalizedStreamEvent::TextDelta {
                text: text.to_owned(),
            }])
        }
        "response.completed" | "response.failed" | "response.incomplete" => {
            let response = value
                .get("response")
                .ok_or(ProviderError::MalformedResponse)?;
            let status = response
                .get("status")
                .and_then(Value::as_str)
                .filter(|status| !status.is_empty())
                .ok_or(ProviderError::MalformedResponse)?;
            let mut events = Vec::new();
            if let Some(usage) = normalized_usage(response)? {
                events.push(NormalizedStreamEvent::Usage { usage });
            }
            events.push(NormalizedStreamEvent::Finish {
                status: status.to_owned(),
            });
            Ok(events)
        }
        "error" => Ok(vec![NormalizedStreamEvent::ProviderError {
            code: value.get("code").and_then(Value::as_str).map(str::to_owned),
        }]),
        unknown => Ok(vec![NormalizedStreamEvent::ProviderWarning {
            event_type: unknown.to_owned(),
        }]),
    }
}

fn normalize_anthropic_event(
    input_tokens: &mut Option<u64>,
    output_tokens: &mut Option<u64>,
    event: SseEvent,
) -> Result<Vec<NormalizedStreamEvent>, ProviderError> {
    let value: Value =
        serde_json::from_str(&event.data).map_err(|_| ProviderError::MalformedResponse)?;
    let event_type = value
        .get("type")
        .and_then(Value::as_str)
        .filter(|kind| !kind.is_empty())
        .ok_or(ProviderError::MalformedResponse)?;
    if event
        .label
        .as_deref()
        .is_some_and(|label| label != event_type)
    {
        return Err(ProviderError::MalformedResponse);
    }
    match event_type {
        "message_start" => {
            if input_tokens.is_some() {
                return Err(ProviderError::MalformedResponse);
            }
            let message = value
                .get("message")
                .filter(|message| {
                    message.get("type").and_then(Value::as_str) == Some("message")
                        && message.get("role").and_then(Value::as_str) == Some("assistant")
                })
                .ok_or(ProviderError::MalformedResponse)?;
            let response_id = message
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or(ProviderError::MalformedResponse)?;
            let usage = message
                .get("usage")
                .ok_or(ProviderError::MalformedResponse)?;
            *input_tokens = Some(
                usage
                    .get("input_tokens")
                    .and_then(Value::as_u64)
                    .ok_or(ProviderError::MalformedResponse)?,
            );
            *output_tokens = Some(
                usage
                    .get("output_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
            );
            Ok(vec![NormalizedStreamEvent::MessageStart {
                provider: RemoteProviderId::Anthropic,
                response_id: response_id.to_owned(),
            }])
        }
        "content_block_start" => {
            let block_type = value
                .get("content_block")
                .and_then(|block| block.get("type"))
                .and_then(Value::as_str)
                .filter(|kind| !kind.is_empty())
                .ok_or(ProviderError::MalformedResponse)?;
            if block_type == "text" {
                Ok(Vec::new())
            } else {
                Ok(vec![NormalizedStreamEvent::ProviderWarning {
                    event_type: format!("anthropic-content-block-{block_type}"),
                }])
            }
        }
        "content_block_delta" => {
            let delta = value.get("delta").ok_or(ProviderError::MalformedResponse)?;
            let delta_type = delta
                .get("type")
                .and_then(Value::as_str)
                .filter(|kind| !kind.is_empty())
                .ok_or(ProviderError::MalformedResponse)?;
            if delta_type == "text_delta" {
                Ok(vec![NormalizedStreamEvent::TextDelta {
                    text: delta
                        .get("text")
                        .and_then(Value::as_str)
                        .ok_or(ProviderError::MalformedResponse)?
                        .to_owned(),
                }])
            } else {
                Ok(vec![NormalizedStreamEvent::ProviderWarning {
                    event_type: format!("anthropic-{delta_type}"),
                }])
            }
        }
        "content_block_stop" | "ping" => Ok(Vec::new()),
        "message_delta" => {
            let usage = value.get("usage").ok_or(ProviderError::MalformedResponse)?;
            if let Some(current_output_tokens) = usage.get("output_tokens").and_then(Value::as_u64)
            {
                if output_tokens.is_some_and(|prior| current_output_tokens < prior) {
                    return Err(ProviderError::MalformedResponse);
                }
                *output_tokens = Some(current_output_tokens);
            }
            let Some(status) = value
                .get("delta")
                .and_then(|delta| delta.get("stop_reason"))
                .and_then(Value::as_str)
                .filter(|status| !status.is_empty())
            else {
                return Ok(Vec::new());
            };
            let input_tokens = input_tokens.ok_or(ProviderError::MalformedResponse)?;
            let output_tokens = output_tokens.ok_or(ProviderError::MalformedResponse)?;
            let total_tokens = input_tokens
                .checked_add(output_tokens)
                .ok_or(ProviderError::MalformedResponse)?;
            Ok(vec![
                NormalizedStreamEvent::Usage {
                    usage: NormalizedUsage {
                        input_tokens,
                        output_tokens,
                        total_tokens,
                    },
                },
                NormalizedStreamEvent::Finish {
                    status: status.to_owned(),
                },
            ])
        }
        "message_stop" => Ok(vec![NormalizedStreamEvent::StreamEnd]),
        "error" => Ok(vec![NormalizedStreamEvent::ProviderError {
            code: value
                .get("error")
                .and_then(|error| error.get("type"))
                .and_then(Value::as_str)
                .map(str::to_owned),
        }]),
        unknown => Ok(vec![NormalizedStreamEvent::ProviderWarning {
            event_type: unknown.to_owned(),
        }]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arbitrary_byte_fragmentation_preserves_unicode_delta() {
        let fixture = concat!(
            "event: response.output_text.delta\r\n",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Evidence: ",
            "雪\"}\r\n\r\n"
        );
        let mut decoder = OpenAiSseDecoder::new();
        let mut events = Vec::new();
        for byte in fixture.as_bytes() {
            events.extend(decoder.push(std::slice::from_ref(byte)).expect("fragment"));
        }
        decoder.finish().expect("complete stream");
        assert_eq!(
            events,
            vec![NormalizedStreamEvent::TextDelta {
                text: "Evidence: 雪".to_owned()
            }]
        );
    }

    #[test]
    fn multiline_data_and_unknown_events_are_tolerated_and_visible() {
        let fixture = concat!(
            ": keepalive\n\n",
            "event: response.future.signal\n",
            "data: {\"type\":\"response.future.signal\",\n",
            "data: \"value\":true}\n\n"
        );
        let mut decoder = OpenAiSseDecoder::new();
        assert_eq!(
            decoder.push(fixture.as_bytes()).expect("events"),
            vec![NormalizedStreamEvent::ProviderWarning {
                event_type: "response.future.signal".to_owned()
            }]
        );
        decoder.finish().expect("complete stream");
    }

    #[test]
    fn completion_normalizes_usage_before_finish() {
        let fixture = concat!(
            "data: {\"type\":\"response.completed\",\"response\":{",
            "\"status\":\"completed\",\"usage\":{\"input_tokens\":9,",
            "\"output_tokens\":3,\"total_tokens\":12}}}\n\n",
            "data: [DONE]\n\n"
        );
        let mut decoder = OpenAiSseDecoder::new();
        assert_eq!(
            decoder.push(fixture.as_bytes()).expect("events"),
            vec![
                NormalizedStreamEvent::Usage {
                    usage: NormalizedUsage {
                        input_tokens: 9,
                        output_tokens: 3,
                        total_tokens: 12
                    }
                },
                NormalizedStreamEvent::Finish {
                    status: "completed".to_owned()
                },
                NormalizedStreamEvent::StreamEnd
            ]
        );
    }

    #[test]
    fn provider_error_message_is_not_exposed() {
        let canary = "provider-error-body-canary";
        let fixture = format!(
            "data: {{\"type\":\"error\",\"code\":\"rate_limit\",\"message\":\"{canary}\"}}\n\n"
        );
        let mut decoder = OpenAiSseDecoder::new();
        let events = decoder.push(fixture.as_bytes()).expect("error event");
        assert_eq!(
            events,
            vec![NormalizedStreamEvent::ProviderError {
                code: Some("rate_limit".to_owned())
            }]
        );
        assert!(!format!("{events:?}").contains(canary));
    }

    #[test]
    fn anthropic_lifecycle_normalizes_usage_and_omits_private_thinking() {
        let fixture = concat!(
            "event: message_start\n",
            "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg-stream\",\"type\":\"message\",\"role\":\"assistant\",\"usage\":{\"input_tokens\":5,\"output_tokens\":1}}}\n\n",
            "event: content_block_start\n",
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\",\"signature\":\"\"}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"private-reasoning-canary\"}}\n\n",
            "event: content_block_start\n",
            "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"bounded answer\"}}\n\n",
            "event: message_delta\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":4}}\n\n",
            "event: message_stop\n",
            "data: {\"type\":\"message_stop\"}\n\n"
        );
        let mut decoder = AnthropicSseDecoder::new();
        let mut events = Vec::new();
        for byte in fixture.as_bytes() {
            events.extend(decoder.push(std::slice::from_ref(byte)).expect("fragment"));
        }
        decoder.finish().expect("complete stream");
        assert_eq!(
            events,
            vec![
                NormalizedStreamEvent::MessageStart {
                    provider: RemoteProviderId::Anthropic,
                    response_id: "msg-stream".to_owned(),
                },
                NormalizedStreamEvent::ProviderWarning {
                    event_type: "anthropic-content-block-thinking".to_owned(),
                },
                NormalizedStreamEvent::ProviderWarning {
                    event_type: "anthropic-thinking_delta".to_owned(),
                },
                NormalizedStreamEvent::TextDelta {
                    text: "bounded answer".to_owned(),
                },
                NormalizedStreamEvent::Usage {
                    usage: NormalizedUsage {
                        input_tokens: 5,
                        output_tokens: 4,
                        total_tokens: 9,
                    },
                },
                NormalizedStreamEvent::Finish {
                    status: "end_turn".to_owned(),
                },
                NormalizedStreamEvent::StreamEnd,
            ]
        );
        assert!(!format!("{events:?}").contains("private-reasoning-canary"));
    }

    #[test]
    fn anthropic_stream_errors_are_sanitized_and_usage_cannot_decrease() {
        let canary = "anthropic-error-body-canary";
        let mut failed = AnthropicSseDecoder::new();
        let events = failed
            .push(
                format!(
                    "event: error\ndata: {{\"type\":\"error\",\"error\":{{\"type\":\"overloaded_error\",\"message\":\"{canary}\"}}}}\n\n"
                )
                .as_bytes(),
            )
            .expect("sanitized error");
        assert_eq!(
            events,
            vec![NormalizedStreamEvent::ProviderError {
                code: Some("overloaded_error".to_owned()),
            }]
        );
        assert!(!format!("{events:?}").contains(canary));

        let mut decreasing = AnthropicSseDecoder::new();
        decreasing
            .push(concat!(
                "event: message_start\n",
                "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg-usage\",\"type\":\"message\",\"role\":\"assistant\",\"usage\":{\"input_tokens\":2,\"output_tokens\":3}}}\n\n"
            ).as_bytes())
            .expect("start");
        assert_eq!(
            decreasing.push(concat!(
                "event: message_delta\n",
                "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}\n\n"
            ).as_bytes()),
            Err(ProviderError::MalformedResponse)
        );
    }

    #[test]
    fn malformed_mismatched_oversized_and_truncated_streams_fail_closed() {
        let mut malformed = OpenAiSseDecoder::new();
        assert_eq!(
            malformed.push(b"data: not-json\n\n"),
            Err(ProviderError::MalformedResponse)
        );

        let mut mismatched = OpenAiSseDecoder::new();
        assert_eq!(
            mismatched
                .push(b"event: response.created\ndata: {\"type\":\"response.completed\"}\n\n"),
            Err(ProviderError::MalformedResponse)
        );

        let mut oversized = OpenAiSseDecoder::new();
        assert_eq!(
            oversized.push(&vec![b'x'; MAX_PENDING_BYTES + 1]),
            Err(ProviderError::ResponseTooLarge)
        );

        let mut truncated = OpenAiSseDecoder::new();
        truncated
            .push(b"data: {\"type\":\"response.created\"}")
            .expect("pending");
        assert_eq!(truncated.finish(), Err(ProviderError::MalformedResponse));
    }
}
