//! Syzygy Tauri backend. Domain logic lives in the modules below; this file wires up
//! state and command handlers. The persisted frontend preference owns engine startup.
mod automation;
pub mod credential_vault;
mod documents;
mod downloads;
mod engine;
pub mod google_auth;
pub mod google_drive;
mod knowledge;
pub mod mcp;
mod mcp_setup;
pub mod model_provider;
mod platform_contracts;
#[doc(hidden)]
pub mod provider_runtime;
pub mod provider_stream;
mod state;
mod updates;
mod vision;

use state::{Downloads, Engine, Granted, KnowledgeCache, MainModel, VisionEngine};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_upload::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Engine(Mutex::new(None)))
        .manage(KnowledgeCache(Mutex::new(HashMap::new())))
        .manage(VisionEngine(Mutex::new(None)))
        .manage(MainModel(Mutex::new(None)))
        .manage(Downloads(Mutex::new(HashMap::new())))
        .manage(Granted(Mutex::new(HashSet::new())))
        .manage(automation::AutomationState::default())
        .manage(provider_runtime::ProviderRuntimeState::default())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            if let Err(error) = automation::start(app.handle()) {
                // MCP is an optional local interoperability surface. A locked/unwritable temp
                // directory must not prevent the primary desktop workspace from opening.
                log::warn!("Live MCP bridge unavailable: {error}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    // This callback is synchronous. Do not let the window disappear until Windows
                    // confirms llama-server exited and released its loaded DLLs/listener.
                    if let Err(error) = engine::shutdown_engine_state(window.app_handle()) {
                        api.prevent_close();
                        log::error!(
                            "Syzygy stayed open because local AI did not finish shutting down: {error}"
                        );
                        window
                            .app_handle()
                            .dialog()
                            .message(format!(
                                "Syzygy is still open because local AI did not release its resources. Try closing again.

{error}"
                            ))
                            .title("Local AI did not finish closing")
                            .kind(MessageDialogKind::Error)
                            .show(|_| {});
                    } else {
                        automation::cleanup(window.app_handle());
                    }
                }
                tauri::WindowEvent::Destroyed => {
                    // Covers programmatic destruction paths that do not emit CloseRequested.
                    automation::cleanup(window.app_handle());
                    if let Err(error) = engine::shutdown_engine_state(window.app_handle()) {
                        log::error!(
                            "Local AI resource verification failed during window destruction: {error}"
                        );
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            engine::gpu_vram,
            engine::vram_total_mb,
            engine::list_models,
            engine::model_dir_path,
            engine::start_engine,
            engine::model_files,
            engine::delete_model,
            engine::shutdown_engine,
            knowledge::folder_info,
            knowledge::retrieve_context,
            knowledge::extract_pdf,
            documents::compile_typst,
            documents::open_path,
            documents::save_document,
            documents::list_documents,
            documents::read_document,
            documents::save_text_document,
            documents::write_temp_file,
            documents::read_text_file,
            documents::write_to_path,
            documents::save_typst_at,
            documents::grant_path,
            vision::vision_present,
            vision::set_vision_mode,
            vision::list_images,
            vision::read_image_data,
            downloads::start_download,
            downloads::pause_download,
            downloads::download_status,
            google_auth::google_oauth_start,
            google_auth::google_oauth_status,
            google_auth::google_oauth_connection,
            google_auth::google_oauth_cancel,
            google_auth::google_oauth_disconnect,
            google_auth::google_drive_create_folder,
            google_drive::google_drive_append_text,
            google_drive::google_drive_list_folder,
            google_drive::google_drive_read_file,
            google_drive::google_drive_retrieve_context,
            google_drive::google_drive_write_sheet_range,
            google_drive::google_drive_workspace,
            google_drive::google_drive_list_workspaces,
            google_drive::google_drive_select_workspace,
            google_drive::google_drive_mirror_dir,
            google_drive::google_drive_sync_folder,
            google_drive::google_drive_mirror_append_log,
            automation::automation_ready,
            automation::automation_respond,
            mcp_setup::mcp_connection_info,
            provider_runtime::provider_generate,
            provider_runtime::provider_cancel,
            provider_runtime::provider_adversarial_authorize,
            provider_runtime::provider_adversarial_revoke,
            provider_runtime::provider_adversarial_authorization_status,
            provider_runtime::provider_credential_set,
            provider_runtime::provider_credential_status,
            provider_runtime::provider_credential_delete,
            updates::app_version
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
