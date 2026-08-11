//! Incremental normalization for provider server-sent event streams.
//!
//! Input can be split at any byte boundary. Unknown future OpenAI, Anthropic, Gemini, or xAI event
//! types are surfaced as warnings instead of crashing or disappearing; malformed JSON, mismatched
//! SSE event labels, unbounded frames, and incomplete terminal sequences fail closed.

use crate::model_provider::{
    normalize_tool_proposal, normalized_usage, valid_tool_call_id, valid_tool_name,
    NormalizedUsage, ProviderError, RemoteProviderId, MAX_TOOL_ARGUMENT_BYTES,
    MAX_TOOL_ARGUMENT_TOTAL_BYTES, MAX_TOOL_CALLS,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

const MAX_PENDING_BYTES: usize = 1024 * 1024;
const MAX_GEMINI_STEPS: usize = 1_024;

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
    ToolCallStart {
        call_id: String,
        name: String,
    },
    ToolCallDelta {
        call_id: String,
        arguments_delta: String,
    },
    ToolCallComplete {
        call_id: String,
        name: String,
        arguments: Value,
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
    tools: ResponsesToolState,
}

#[derive(Default)]
pub struct XaiSseDecoder {
    frames: SseFrameDecoder,
    tools: ResponsesToolState,
}

#[derive(Default)]
pub struct AnthropicSseDecoder {
    frames: SseFrameDecoder,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    active_tools: BTreeMap<u64, ToolCallAssembly>,
    tool_call_ids: BTreeSet<String>,
    tool_argument_bytes: usize,
}

#[derive(Default)]
pub struct GeminiSseDecoder {
    frames: SseFrameDecoder,
    response_id: Option<String>,
    active_steps: BTreeMap<u64, String>,
    seen_steps: BTreeSet<u64>,
    tool_call_ids: BTreeSet<String>,
    tool_argument_bytes: usize,
}

#[derive(Default)]
struct ResponsesToolState {
    active: BTreeMap<String, ToolCallAssembly>,
    completed: BTreeMap<String, ToolCallAssembly>,
    call_ids: BTreeSet<String>,
    argument_bytes: usize,
}

#[derive(Clone)]
struct ToolCallAssembly {
    call_id: String,
    name: String,
    arguments: String,
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
            events.extend(normalize_responses_event(
                RemoteProviderId::OpenAi,
                &mut self.tools,
                event,
            )?);
        }
        Ok(events)
    }

    pub fn finish(self) -> Result<(), ProviderError> {
        self.frames.finish()?;
        self.tools.finish()
    }
}

impl XaiSseDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<NormalizedStreamEvent>, ProviderError> {
        let mut events = Vec::new();
        for event in self.frames.push(bytes)? {
            events.extend(normalize_responses_event(
                RemoteProviderId::Xai,
                &mut self.tools,
                event,
            )?);
        }
        Ok(events)
    }

    pub fn finish(self) -> Result<(), ProviderError> {
        self.frames.finish()?;
        self.tools.finish()
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
                &mut self.active_tools,
                &mut self.tool_call_ids,
                &mut self.tool_argument_bytes,
                event,
            )?);
        }
        Ok(events)
    }

    pub fn finish(self) -> Result<(), ProviderError> {
        self.frames.finish()?;
        if self.active_tools.is_empty() {
            Ok(())
        } else {
            Err(ProviderError::MalformedResponse)
        }
    }
}

impl GeminiSseDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<NormalizedStreamEvent>, ProviderError> {
        let mut events = Vec::new();
        for event in self.frames.push(bytes)? {
            events.extend(normalize_gemini_event(
                &mut self.response_id,
                &mut self.active_steps,
                &mut self.seen_steps,
                &mut self.tool_call_ids,
                &mut self.tool_argument_bytes,
                event,
            )?);
        }
        Ok(events)
    }

    pub fn finish(self) -> Result<(), ProviderError> {
        self.frames.finish()?;
        if self.active_steps.is_empty() {
            Ok(())
        } else {
            Err(ProviderError::MalformedResponse)
        }
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

fn checked_tool_arguments(raw: &str) -> Result<Value, ProviderError> {
    if raw.len() > MAX_TOOL_ARGUMENT_BYTES {
        return Err(ProviderError::ResponseTooLarge);
    }
    let arguments: Value =
        serde_json::from_str(raw).map_err(|_| ProviderError::MalformedResponse)?;
    if !arguments.is_object() {
        return Err(ProviderError::MalformedResponse);
    }
    Ok(arguments)
}

fn append_tool_delta(
    assembly: &mut ToolCallAssembly,
    total_argument_bytes: &mut usize,
    delta: &str,
) -> Result<NormalizedStreamEvent, ProviderError> {
    if delta.is_empty() || delta.contains('\0') {
        return Err(ProviderError::MalformedResponse);
    }
    let next_call_bytes = assembly
        .arguments
        .len()
        .checked_add(delta.len())
        .filter(|bytes| *bytes <= MAX_TOOL_ARGUMENT_BYTES)
        .ok_or(ProviderError::ResponseTooLarge)?;
    *total_argument_bytes = total_argument_bytes
        .checked_add(delta.len())
        .filter(|bytes| *bytes <= MAX_TOOL_ARGUMENT_TOTAL_BYTES)
        .ok_or(ProviderError::ResponseTooLarge)?;
    assembly.arguments.push_str(delta);
    debug_assert_eq!(assembly.arguments.len(), next_call_bytes);
    Ok(NormalizedStreamEvent::ToolCallDelta {
        call_id: assembly.call_id.clone(),
        arguments_delta: delta.to_owned(),
    })
}

impl ResponsesToolState {
    fn start(
        &mut self,
        item_id: &str,
        call_id: &str,
        name: &str,
        initial_arguments: &str,
    ) -> Result<Vec<NormalizedStreamEvent>, ProviderError> {
        if self.active.len() + self.completed.len() >= MAX_TOOL_CALLS
            || !valid_tool_call_id(item_id)
            || !valid_tool_call_id(call_id)
            || !valid_tool_name(name)
            || self.active.contains_key(item_id)
            || self.completed.contains_key(item_id)
            || !self.call_ids.insert(call_id.to_owned())
        {
            return Err(ProviderError::MalformedResponse);
        }
        let mut assembly = ToolCallAssembly {
            call_id: call_id.to_owned(),
            name: name.to_owned(),
            arguments: String::new(),
        };
        let mut events = vec![NormalizedStreamEvent::ToolCallStart {
            call_id: call_id.to_owned(),
            name: name.to_owned(),
        }];
        if !initial_arguments.is_empty() {
            events.push(append_tool_delta(
                &mut assembly,
                &mut self.argument_bytes,
                initial_arguments,
            )?);
        }
        self.active.insert(item_id.to_owned(), assembly);
        Ok(events)
    }

    fn delta(
        &mut self,
        item_id: &str,
        delta: &str,
    ) -> Result<Vec<NormalizedStreamEvent>, ProviderError> {
        let assembly = self
            .active
            .get_mut(item_id)
            .ok_or(ProviderError::MalformedResponse)?;
        Ok(vec![append_tool_delta(
            assembly,
            &mut self.argument_bytes,
            delta,
        )?])
    }

    fn complete(
        &mut self,
        item_id: &str,
        call_id: Option<&str>,
        name: Option<&str>,
        final_arguments: &str,
    ) -> Result<Vec<NormalizedStreamEvent>, ProviderError> {
        if let Some(completed) = self.completed.get(item_id) {
            if call_id.is_some_and(|value| value != completed.call_id)
                || name.is_some_and(|value| value != completed.name)
                || final_arguments != completed.arguments
            {
                return Err(ProviderError::MalformedResponse);
            }
            return Ok(Vec::new());
        }
        if !self.active.contains_key(item_id) {
            let call_id = call_id.ok_or(ProviderError::MalformedResponse)?;
            let name = name.ok_or(ProviderError::MalformedResponse)?;
            let mut events = self.start(item_id, call_id, name, "")?;
            if !final_arguments.is_empty() {
                events.extend(self.delta(item_id, final_arguments)?);
            }
            events.extend(self.complete(item_id, Some(call_id), Some(name), final_arguments)?);
            return Ok(events);
        }
        let mut assembly = self
            .active
            .remove(item_id)
            .ok_or(ProviderError::MalformedResponse)?;
        if call_id.is_some_and(|value| value != assembly.call_id)
            || name.is_some_and(|value| value != assembly.name)
        {
            return Err(ProviderError::MalformedResponse);
        }
        let mut events = Vec::new();
        if assembly.arguments.is_empty() && !final_arguments.is_empty() {
            events.push(append_tool_delta(
                &mut assembly,
                &mut self.argument_bytes,
                final_arguments,
            )?);
        } else if assembly.arguments != final_arguments {
            return Err(ProviderError::MalformedResponse);
        }
        let arguments = checked_tool_arguments(&assembly.arguments)?;
        normalize_tool_proposal(&assembly.call_id, &assembly.name, arguments.clone())?;
        events.push(NormalizedStreamEvent::ToolCallComplete {
            call_id: assembly.call_id.clone(),
            name: assembly.name.clone(),
            arguments,
        });
        self.completed.insert(item_id.to_owned(), assembly);
        Ok(events)
    }

    fn finish(self) -> Result<(), ProviderError> {
        if self.active.is_empty() {
            Ok(())
        } else {
            Err(ProviderError::MalformedResponse)
        }
    }
}

fn normalize_responses_event(
    provider: RemoteProviderId,
    tools: &mut ResponsesToolState,
    event: SseEvent,
) -> Result<Vec<NormalizedStreamEvent>, ProviderError> {
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
                provider,
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
        "response.output_item.added" => {
            let item = value.get("item").ok_or(ProviderError::MalformedResponse)?;
            let item_type = item
                .get("type")
                .and_then(Value::as_str)
                .ok_or(ProviderError::MalformedResponse)?;
            if item_type != "function_call" {
                return Ok(vec![NormalizedStreamEvent::ProviderWarning {
                    event_type: format!("response-output-item-{item_type}"),
                }]);
            }
            tools.start(
                item.get("id")
                    .and_then(Value::as_str)
                    .ok_or(ProviderError::MalformedResponse)?,
                item.get("call_id")
                    .and_then(Value::as_str)
                    .ok_or(ProviderError::MalformedResponse)?,
                item.get("name")
                    .and_then(Value::as_str)
                    .ok_or(ProviderError::MalformedResponse)?,
                item.get("arguments")
                    .and_then(Value::as_str)
                    .ok_or(ProviderError::MalformedResponse)?,
            )
        }
        "response.function_call_arguments.delta" => tools.delta(
            value
                .get("item_id")
                .and_then(Value::as_str)
                .ok_or(ProviderError::MalformedResponse)?,
            value
                .get("delta")
                .and_then(Value::as_str)
                .ok_or(ProviderError::MalformedResponse)?,
        ),
        "response.function_call_arguments.done" => tools.complete(
            value
                .get("item_id")
                .and_then(Value::as_str)
                .ok_or(ProviderError::MalformedResponse)?,
            value.get("call_id").and_then(Value::as_str),
            value.get("name").and_then(Value::as_str),
            value
                .get("arguments")
                .and_then(Value::as_str)
                .ok_or(ProviderError::MalformedResponse)?,
        ),
        "response.output_item.done" => {
            let item = value.get("item").ok_or(ProviderError::MalformedResponse)?;
            let item_type = item
                .get("type")
                .and_then(Value::as_str)
                .ok_or(ProviderError::MalformedResponse)?;
            if item_type != "function_call" {
                return Ok(vec![NormalizedStreamEvent::ProviderWarning {
                    event_type: format!("response-output-item-done-{item_type}"),
                }]);
            }
            tools.complete(
                item.get("id")
                    .and_then(Value::as_str)
                    .ok_or(ProviderError::MalformedResponse)?,
                item.get("call_id").and_then(Value::as_str),
                item.get("name").and_then(Value::as_str),
                item.get("arguments")
                    .and_then(Value::as_str)
                    .ok_or(ProviderError::MalformedResponse)?,
            )
        }
        "response.completed" | "response.failed" | "response.incomplete" => {
            if !tools.active.is_empty() {
                return Err(ProviderError::MalformedResponse);
            }
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
    active_tools: &mut BTreeMap<u64, ToolCallAssembly>,
    tool_call_ids: &mut BTreeSet<String>,
    tool_argument_bytes: &mut usize,
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
            let index = value
                .get("index")
                .and_then(Value::as_u64)
                .ok_or(ProviderError::MalformedResponse)?;
            let block = value
                .get("content_block")
                .ok_or(ProviderError::MalformedResponse)?;
            let block_type = block
                .get("type")
                .and_then(Value::as_str)
                .filter(|kind| !kind.is_empty())
                .ok_or(ProviderError::MalformedResponse)?;
            if block_type == "text" {
                Ok(Vec::new())
            } else if block_type == "tool_use" {
                let call_id = block
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or(ProviderError::MalformedResponse)?;
                let name = block
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or(ProviderError::MalformedResponse)?;
                let input = block
                    .get("input")
                    .and_then(Value::as_object)
                    .ok_or(ProviderError::MalformedResponse)?;
                if !input.is_empty()
                    || active_tools.contains_key(&index)
                    || tool_call_ids.len() >= MAX_TOOL_CALLS
                    || !valid_tool_call_id(call_id)
                    || !valid_tool_name(name)
                    || !tool_call_ids.insert(call_id.to_owned())
                {
                    return Err(ProviderError::MalformedResponse);
                }
                active_tools.insert(
                    index,
                    ToolCallAssembly {
                        call_id: call_id.to_owned(),
                        name: name.to_owned(),
                        arguments: String::new(),
                    },
                );
                Ok(vec![NormalizedStreamEvent::ToolCallStart {
                    call_id: call_id.to_owned(),
                    name: name.to_owned(),
                }])
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
            } else if delta_type == "input_json_delta" {
                let index = value
                    .get("index")
                    .and_then(Value::as_u64)
                    .ok_or(ProviderError::MalformedResponse)?;
                let assembly = active_tools
                    .get_mut(&index)
                    .ok_or(ProviderError::MalformedResponse)?;
                Ok(vec![append_tool_delta(
                    assembly,
                    tool_argument_bytes,
                    delta
                        .get("partial_json")
                        .and_then(Value::as_str)
                        .ok_or(ProviderError::MalformedResponse)?,
                )?])
            } else {
                Ok(vec![NormalizedStreamEvent::ProviderWarning {
                    event_type: format!("anthropic-{delta_type}"),
                }])
            }
        }
        "content_block_stop" => {
            let index = value
                .get("index")
                .and_then(Value::as_u64)
                .ok_or(ProviderError::MalformedResponse)?;
            let Some(assembly) = active_tools.remove(&index) else {
                return Ok(Vec::new());
            };
            let arguments = checked_tool_arguments(&assembly.arguments)?;
            normalize_tool_proposal(&assembly.call_id, &assembly.name, arguments.clone())?;
            Ok(vec![NormalizedStreamEvent::ToolCallComplete {
                call_id: assembly.call_id,
                name: assembly.name,
                arguments,
            }])
        }
        "ping" => Ok(Vec::new()),
        "message_delta" => {
            if !active_tools.is_empty() {
                return Err(ProviderError::MalformedResponse);
            }
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
        "message_stop" => {
            if !active_tools.is_empty() {
                return Err(ProviderError::MalformedResponse);
            }
            Ok(vec![NormalizedStreamEvent::StreamEnd])
        }
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

fn normalize_gemini_usage(usage: &Value) -> Result<NormalizedUsage, ProviderError> {
    let input_tokens = usage
        .get("total_input_tokens")
        .and_then(Value::as_u64)
        .ok_or(ProviderError::MalformedResponse)?;
    let output_tokens = usage
        .get("total_output_tokens")
        .and_then(Value::as_u64)
        .ok_or(ProviderError::MalformedResponse)?;
    let total_tokens = usage
        .get("total_tokens")
        .and_then(Value::as_u64)
        .ok_or(ProviderError::MalformedResponse)?;
    if total_tokens
        < input_tokens
            .checked_add(output_tokens)
            .ok_or(ProviderError::MalformedResponse)?
    {
        return Err(ProviderError::MalformedResponse);
    }
    Ok(NormalizedUsage {
        input_tokens,
        output_tokens,
        total_tokens,
    })
}

fn gemini_model_output_start(step: &Value) -> Result<Vec<NormalizedStreamEvent>, ProviderError> {
    let Some(content) = step.get("content") else {
        return Ok(Vec::new());
    };
    let content = content.as_array().ok_or(ProviderError::MalformedResponse)?;
    let mut events = Vec::new();
    for block in content {
        let block_type = block
            .get("type")
            .and_then(Value::as_str)
            .filter(|kind| !kind.is_empty())
            .ok_or(ProviderError::MalformedResponse)?;
        if block_type == "text" {
            let text = block
                .get("text")
                .and_then(Value::as_str)
                .ok_or(ProviderError::MalformedResponse)?;
            if !text.is_empty() {
                events.push(NormalizedStreamEvent::TextDelta {
                    text: text.to_owned(),
                });
            }
        } else {
            events.push(NormalizedStreamEvent::ProviderWarning {
                event_type: format!("gemini-model_output-{block_type}"),
            });
        }
    }
    Ok(events)
}

fn gemini_function_call_start(
    step: &Value,
    tool_call_ids: &mut BTreeSet<String>,
    tool_argument_bytes: &mut usize,
) -> Result<Vec<NormalizedStreamEvent>, ProviderError> {
    let call_id = step
        .get("id")
        .and_then(Value::as_str)
        .ok_or(ProviderError::MalformedResponse)?;
    let name = step
        .get("name")
        .and_then(Value::as_str)
        .ok_or(ProviderError::MalformedResponse)?;
    let arguments = step
        .get("arguments")
        .cloned()
        .ok_or(ProviderError::MalformedResponse)?;
    let proposal = normalize_tool_proposal(call_id, name, arguments.clone())?;
    if tool_call_ids.len() >= MAX_TOOL_CALLS || !tool_call_ids.insert(call_id.to_owned()) {
        return Err(ProviderError::MalformedResponse);
    }
    let arguments_delta =
        serde_json::to_string(&arguments).map_err(|_| ProviderError::MalformedResponse)?;
    *tool_argument_bytes = tool_argument_bytes
        .checked_add(arguments_delta.len())
        .filter(|bytes| *bytes <= MAX_TOOL_ARGUMENT_TOTAL_BYTES)
        .ok_or(ProviderError::ResponseTooLarge)?;
    Ok(vec![
        NormalizedStreamEvent::ToolCallStart {
            call_id: proposal.call_id.clone(),
            name: proposal.name.clone(),
        },
        NormalizedStreamEvent::ToolCallDelta {
            call_id: proposal.call_id.clone(),
            arguments_delta,
        },
        NormalizedStreamEvent::ToolCallComplete {
            call_id: proposal.call_id,
            name: proposal.name,
            arguments,
        },
    ])
}

fn normalize_gemini_event(
    response_id: &mut Option<String>,
    active_steps: &mut BTreeMap<u64, String>,
    seen_steps: &mut BTreeSet<u64>,
    tool_call_ids: &mut BTreeSet<String>,
    tool_argument_bytes: &mut usize,
    event: SseEvent,
) -> Result<Vec<NormalizedStreamEvent>, ProviderError> {
    if event.data == "[DONE]" {
        if event.label.as_deref().is_some_and(|label| label != "done") {
            return Err(ProviderError::MalformedResponse);
        }
        return Ok(vec![NormalizedStreamEvent::StreamEnd]);
    }
    let value: Value =
        serde_json::from_str(&event.data).map_err(|_| ProviderError::MalformedResponse)?;
    let event_type = value
        .get("event_type")
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
        "interaction.created" => {
            if response_id.is_some() {
                return Err(ProviderError::MalformedResponse);
            }
            let interaction = value
                .get("interaction")
                .ok_or(ProviderError::MalformedResponse)?;
            let id = interaction
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or(ProviderError::MalformedResponse)?;
            interaction
                .get("status")
                .and_then(Value::as_str)
                .filter(|status| !status.is_empty())
                .ok_or(ProviderError::MalformedResponse)?;
            if interaction
                .get("object")
                .and_then(Value::as_str)
                .is_some_and(|object| object != "interaction")
            {
                return Err(ProviderError::MalformedResponse);
            }
            *response_id = Some(id.to_owned());
            Ok(vec![NormalizedStreamEvent::MessageStart {
                provider: RemoteProviderId::Gemini,
                response_id: id.to_owned(),
            }])
        }
        "step.start" => {
            if response_id.is_none() || seen_steps.len() >= MAX_GEMINI_STEPS {
                return Err(ProviderError::MalformedResponse);
            }
            let index = value
                .get("index")
                .and_then(Value::as_u64)
                .ok_or(ProviderError::MalformedResponse)?;
            if !seen_steps.insert(index) {
                return Err(ProviderError::MalformedResponse);
            }
            let step = value.get("step").ok_or(ProviderError::MalformedResponse)?;
            let step_type = step
                .get("type")
                .and_then(Value::as_str)
                .filter(|kind| !kind.is_empty())
                .ok_or(ProviderError::MalformedResponse)?
                .to_owned();
            active_steps.insert(index, step_type.clone());
            if step_type == "model_output" {
                gemini_model_output_start(step)
            } else if step_type == "function_call" {
                gemini_function_call_start(step, tool_call_ids, tool_argument_bytes)
            } else {
                Ok(vec![NormalizedStreamEvent::ProviderWarning {
                    event_type: format!("gemini-step-{step_type}"),
                }])
            }
        }
        "step.delta" => {
            let index = value
                .get("index")
                .and_then(Value::as_u64)
                .ok_or(ProviderError::MalformedResponse)?;
            let step_type = active_steps
                .get(&index)
                .ok_or(ProviderError::MalformedResponse)?;
            let delta = value.get("delta").ok_or(ProviderError::MalformedResponse)?;
            let delta_type = delta
                .get("type")
                .and_then(Value::as_str)
                .filter(|kind| !kind.is_empty())
                .ok_or(ProviderError::MalformedResponse)?;
            if step_type == "model_output" && delta_type == "text" {
                Ok(vec![NormalizedStreamEvent::TextDelta {
                    text: delta
                        .get("text")
                        .and_then(Value::as_str)
                        .ok_or(ProviderError::MalformedResponse)?
                        .to_owned(),
                }])
            } else {
                Ok(vec![NormalizedStreamEvent::ProviderWarning {
                    event_type: format!("gemini-{step_type}-{delta_type}"),
                }])
            }
        }
        "step.stop" => {
            let index = value
                .get("index")
                .and_then(Value::as_u64)
                .ok_or(ProviderError::MalformedResponse)?;
            if active_steps.remove(&index).is_none() {
                return Err(ProviderError::MalformedResponse);
            }
            Ok(Vec::new())
        }
        "interaction.completed" => {
            if !active_steps.is_empty() {
                return Err(ProviderError::MalformedResponse);
            }
            let interaction = value
                .get("interaction")
                .ok_or(ProviderError::MalformedResponse)?;
            let id = interaction
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or(ProviderError::MalformedResponse)?;
            if response_id.as_deref() != Some(id) {
                return Err(ProviderError::MalformedResponse);
            }
            let status = interaction
                .get("status")
                .and_then(Value::as_str)
                .filter(|status| !status.is_empty())
                .ok_or(ProviderError::MalformedResponse)?;
            let mut events = Vec::new();
            if let Some(usage) = interaction.get("usage").filter(|usage| !usage.is_null()) {
                events.push(NormalizedStreamEvent::Usage {
                    usage: normalize_gemini_usage(usage)?,
                });
            }
            events.push(NormalizedStreamEvent::Finish {
                status: status.to_owned(),
            });
            Ok(events)
        }
        "error" => Ok(vec![NormalizedStreamEvent::ProviderError {
            code: value
                .get("error")
                .and_then(|error| error.get("code"))
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
    fn xai_responses_decoder_preserves_provider_identity_and_omits_error_body() {
        let canary = "xai-private-error-canary";
        let error = format!(
            "data: {{\"type\":\"error\",\"code\":\"rate_limit\",\"message\":\"{canary}\"}}\n\n"
        );
        let fixture = format!(
            "{}{error}",
            concat!(
                "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp-xai\"}}\n\n",
                "data: {\"type\":\"response.output_text.delta\",\"delta\":\"bounded answer\"}\n\n"
            )
        );
        let mut decoder = XaiSseDecoder::new();
        let events = decoder.push(fixture.as_bytes()).expect("xAI events");
        assert_eq!(
            events,
            vec![
                NormalizedStreamEvent::MessageStart {
                    provider: RemoteProviderId::Xai,
                    response_id: "resp-xai".to_owned(),
                },
                NormalizedStreamEvent::TextDelta {
                    text: "bounded answer".to_owned(),
                },
                NormalizedStreamEvent::ProviderError {
                    code: Some("rate_limit".to_owned()),
                },
            ]
        );
        assert!(!format!("{events:?}").contains(canary));
        decoder.finish().expect("complete xAI stream");
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
    fn gemini_step_lifecycle_normalizes_text_tool_usage_and_omits_private_reasoning() {
        let fixture = concat!(
            "event: interaction.created\n",
            "data: {\"event_type\":\"interaction.created\",\"interaction\":{\"id\":\"interaction-stream\",\"object\":\"interaction\",\"model\":\"gemini-fixture\",\"status\":\"in_progress\"}}\n\n",
            "event: step.start\n",
            "data: {\"event_type\":\"step.start\",\"index\":0,\"step\":{\"type\":\"thought\",\"summary\":[{\"type\":\"text\",\"text\":\"private-thought-summary-canary\"}]}}\n\n",
            "event: step.delta\n",
            "data: {\"event_type\":\"step.delta\",\"index\":0,\"delta\":{\"type\":\"thought_signature\",\"signature\":\"private-signature-canary\"}}\n\n",
            "event: step.stop\n",
            "data: {\"event_type\":\"step.stop\",\"index\":0}\n\n",
            "event: step.start\n",
            "data: {\"event_type\":\"step.start\",\"index\":1,\"step\":{\"type\":\"function_call\",\"id\":\"call-gemini-1\",\"name\":\"lookup_source\",\"arguments\":{\"query\":\"tool-argument-canary\"}}}\n\n",
            "event: step.stop\n",
            "data: {\"event_type\":\"step.stop\",\"index\":1}\n\n",
            "event: step.start\n",
            "data: {\"event_type\":\"step.start\",\"index\":2,\"step\":{\"type\":\"model_output\",\"content\":[{\"type\":\"text\",\"text\":\"Bounded \"}]}}\n\n",
            "event: step.delta\n",
            "data: {\"event_type\":\"step.delta\",\"index\":2,\"delta\":{\"type\":\"text\",\"text\":\"finding.\"}}\n\n",
            "event: step.stop\n",
            "data: {\"event_type\":\"step.stop\",\"index\":2}\n\n",
            "event: interaction.completed\n",
            "data: {\"event_type\":\"interaction.completed\",\"interaction\":{\"id\":\"interaction-stream\",\"status\":\"completed\",\"usage\":{\"total_input_tokens\":10,\"total_output_tokens\":3,\"total_thought_tokens\":4,\"total_tokens\":17}}}\n\n",
            "event: done\n",
            "data: [DONE]\n\n"
        );
        let mut decoder = GeminiSseDecoder::new();
        let mut events = Vec::new();
        for byte in fixture.as_bytes() {
            events.extend(decoder.push(std::slice::from_ref(byte)).expect("fragment"));
        }
        decoder.finish().expect("complete stream");
        assert_eq!(
            events,
            vec![
                NormalizedStreamEvent::MessageStart {
                    provider: RemoteProviderId::Gemini,
                    response_id: "interaction-stream".to_owned(),
                },
                NormalizedStreamEvent::ProviderWarning {
                    event_type: "gemini-step-thought".to_owned(),
                },
                NormalizedStreamEvent::ProviderWarning {
                    event_type: "gemini-thought-thought_signature".to_owned(),
                },
                NormalizedStreamEvent::ToolCallStart {
                    call_id: "call-gemini-1".to_owned(),
                    name: "lookup_source".to_owned(),
                },
                NormalizedStreamEvent::ToolCallDelta {
                    call_id: "call-gemini-1".to_owned(),
                    arguments_delta: "{\"query\":\"tool-argument-canary\"}".to_owned(),
                },
                NormalizedStreamEvent::ToolCallComplete {
                    call_id: "call-gemini-1".to_owned(),
                    name: "lookup_source".to_owned(),
                    arguments: serde_json::json!({ "query": "tool-argument-canary" }),
                },
                NormalizedStreamEvent::TextDelta {
                    text: "Bounded ".to_owned(),
                },
                NormalizedStreamEvent::TextDelta {
                    text: "finding.".to_owned(),
                },
                NormalizedStreamEvent::Usage {
                    usage: NormalizedUsage {
                        input_tokens: 10,
                        output_tokens: 3,
                        total_tokens: 17,
                    },
                },
                NormalizedStreamEvent::Finish {
                    status: "completed".to_owned(),
                },
                NormalizedStreamEvent::StreamEnd,
            ]
        );
        let serialized = format!("{events:?}");
        assert!(!serialized.contains("private-thought-summary-canary"));
        assert!(!serialized.contains("private-signature-canary"));
        assert!(serialized.contains("lookup_source"));
        assert!(serialized.contains("tool-argument-canary"));
    }

    #[test]
    fn gemini_stream_errors_and_step_identity_fail_closed_without_body_leakage() {
        let canary = "gemini-error-body-canary";
        let mut failed = GeminiSseDecoder::new();
        let events = failed
            .push(
                format!(
                    "event: error\ndata: {{\"event_type\":\"error\",\"error\":{{\"code\":\"resource_exhausted\",\"message\":\"{canary}\"}}}}\n\n"
                )
                .as_bytes(),
            )
            .expect("sanitized error");
        assert_eq!(
            events,
            vec![NormalizedStreamEvent::ProviderError {
                code: Some("resource_exhausted".to_owned()),
            }]
        );
        assert!(!format!("{events:?}").contains(canary));

        let mut orphan = GeminiSseDecoder::new();
        orphan
            .push(concat!(
                "event: interaction.created\n",
                "data: {\"event_type\":\"interaction.created\",\"interaction\":{\"id\":\"interaction-a\",\"status\":\"in_progress\"}}\n\n"
            ).as_bytes())
            .expect("created");
        assert_eq!(
            orphan.push(concat!(
                "event: step.delta\n",
                "data: {\"event_type\":\"step.delta\",\"index\":7,\"delta\":{\"type\":\"text\",\"text\":\"orphan\"}}\n\n"
            ).as_bytes()),
            Err(ProviderError::MalformedResponse)
        );

        let mut mismatched = GeminiSseDecoder::new();
        mismatched
            .push(concat!(
                "event: interaction.created\n",
                "data: {\"event_type\":\"interaction.created\",\"interaction\":{\"id\":\"interaction-a\",\"status\":\"in_progress\"}}\n\n"
            ).as_bytes())
            .expect("created");
        assert_eq!(
            mismatched.push(concat!(
                "event: interaction.completed\n",
                "data: {\"event_type\":\"interaction.completed\",\"interaction\":{\"id\":\"interaction-b\",\"status\":\"completed\"}}\n\n"
            ).as_bytes()),
            Err(ProviderError::MalformedResponse)
        );
    }

    #[test]
    fn provider_tool_call_shapes_normalize_to_one_non_executing_lifecycle() {
        let mut openai = OpenAiSseDecoder::new();
        let openai_events = openai
            .push(concat!(
                "event: response.output_item.added\n",
                "data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"function_call\",\"id\":\"fc-1\",\"call_id\":\"call-1\",\"name\":\"lookup_source\",\"arguments\":\"\"}}\n\n",
                "event: response.function_call_arguments.delta\n",
                "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc-1\",\"delta\":\"{\\\"query\\\":\"}\n\n",
                "event: response.function_call_arguments.delta\n",
                "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc-1\",\"delta\":\"\\\"budget\\\"}\"}\n\n",
                "event: response.function_call_arguments.done\n",
                "data: {\"type\":\"response.function_call_arguments.done\",\"item_id\":\"fc-1\",\"arguments\":\"{\\\"query\\\":\\\"budget\\\"}\"}\n\n",
                "event: response.output_item.done\n",
                "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"function_call\",\"id\":\"fc-1\",\"call_id\":\"call-1\",\"name\":\"lookup_source\",\"arguments\":\"{\\\"query\\\":\\\"budget\\\"}\"}}\n\n"
            ).as_bytes())
            .expect("OpenAI tool lifecycle");
        openai.finish().expect("complete OpenAI tool");
        assert_eq!(
            openai_events,
            vec![
                NormalizedStreamEvent::ToolCallStart {
                    call_id: "call-1".to_owned(),
                    name: "lookup_source".to_owned(),
                },
                NormalizedStreamEvent::ToolCallDelta {
                    call_id: "call-1".to_owned(),
                    arguments_delta: "{\"query\":".to_owned(),
                },
                NormalizedStreamEvent::ToolCallDelta {
                    call_id: "call-1".to_owned(),
                    arguments_delta: "\"budget\"}".to_owned(),
                },
                NormalizedStreamEvent::ToolCallComplete {
                    call_id: "call-1".to_owned(),
                    name: "lookup_source".to_owned(),
                    arguments: serde_json::json!({ "query": "budget" }),
                },
            ]
        );

        let mut anthropic = AnthropicSseDecoder::new();
        let anthropic_events = anthropic
            .push(concat!(
                "event: content_block_start\n",
                "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu-1\",\"name\":\"lookup_source\",\"input\":{}}}\n\n",
                "event: content_block_delta\n",
                "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"query\\\":\\\"budget\\\"}\"}}\n\n",
                "event: content_block_stop\n",
                "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n"
            ).as_bytes())
            .expect("Anthropic tool lifecycle");
        anthropic.finish().expect("complete Anthropic tool");
        assert_eq!(anthropic_events.len(), 3);
        assert!(matches!(
            anthropic_events.last(),
            Some(NormalizedStreamEvent::ToolCallComplete { arguments, .. })
                if arguments == &serde_json::json!({ "query": "budget" })
        ));

        let mut xai = XaiSseDecoder::new();
        let xai_events = xai
            .push(concat!(
                "event: response.output_item.done\n",
                "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"function_call\",\"id\":\"fc-x\",\"call_id\":\"call-x\",\"name\":\"lookup_source\",\"arguments\":\"{\\\"query\\\":\\\"budget\\\"}\"}}\n\n"
            ).as_bytes())
            .expect("xAI whole tool call");
        xai.finish().expect("complete xAI tool");
        assert_eq!(xai_events.len(), 3);
        assert!(matches!(
            xai_events.first(),
            Some(NormalizedStreamEvent::ToolCallStart { call_id, .. }) if call_id == "call-x"
        ));
    }

    #[test]
    fn malformed_or_incomplete_tool_calls_fail_closed() {
        let mut orphan = OpenAiSseDecoder::new();
        assert_eq!(
            orphan.push(concat!(
                "event: response.function_call_arguments.delta\n",
                "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"missing\",\"delta\":\"{}\"}\n\n"
            ).as_bytes()),
            Err(ProviderError::MalformedResponse)
        );

        let mut invalid_json = AnthropicSseDecoder::new();
        invalid_json.push(concat!(
            "event: content_block_start\n",
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu-bad\",\"name\":\"lookup_source\",\"input\":{}}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{bad\"}}\n\n"
        ).as_bytes()).expect("partial invalid JSON remains pending");
        assert_eq!(
            invalid_json.push(
                concat!(
                    "event: content_block_stop\n",
                    "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n"
                )
                .as_bytes()
            ),
            Err(ProviderError::MalformedResponse)
        );

        let mut incomplete = OpenAiSseDecoder::new();
        incomplete.push(concat!(
            "event: response.output_item.added\n",
            "data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"function_call\",\"id\":\"fc-pending\",\"call_id\":\"call-pending\",\"name\":\"lookup_source\",\"arguments\":\"\"}}\n\n"
        ).as_bytes()).expect("pending tool");
        assert_eq!(incomplete.finish(), Err(ProviderError::MalformedResponse));
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
