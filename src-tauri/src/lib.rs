mod browser;
mod commands;
mod cua;
mod flashcards;
mod memory;
mod oauth;
mod plugins;
mod secrets;
mod teach;
mod wake_word;

use browser::*;
use commands::*;
use cua::*;
use flashcards::*;
use memory::*;
use oauth::*;
use plugins::*;
use secrets::*;
use teach::*;
use wake_word::*;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            #[cfg(target_os = "macos")]
            {
                use cocoa::appkit::{NSColor, NSWindow};
                use cocoa::base::nil;

                let win = app
                    .get_webview_window("main")
                    .expect("main window not found");
                let ns_win = win.ns_window().unwrap() as cocoa::base::id;
                unsafe {
                    let clear = NSColor::clearColor(nil);
                    ns_win.setBackgroundColor_(clear);
                    ns_win.setOpaque_(cocoa::base::NO);
                    ns_win.setHasShadow_(cocoa::base::NO);
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_ephemeral_key,
            capture_active_window,
            capture_if_changed,
            get_config,
            transcribe_audio,
            list_displays,
            set_default_display,
            start_recording,
            stop_recording,
            analyze_recording,
            transcribe_recording,
            check_screen_for_language,
            check_audio_for_language,
            get_attention_state,
            triage_observation,
            start_learning_audio,
            stop_learning_audio,
            check_learning_audio,
            get_selected_text,
            memory_clear,
            memory_get_context,
            memory_set_fact,
            memory_mark_known,
            memory_add_correction,
            extract_session_feedback,
            get_flashcard_deck,
            save_flashcard,
            delete_flashcard,
            read_flashcard_file,
            increment_flashcard_review,
            teach_from_content,
            annotate_lines,
            read_audio_base64,
            download_song_audio,
            append_transcript_window,
            assess_viewing_session,
            get_plugin_dir,
            list_plugins,
            read_plugin,
            write_plugin,
            delete_plugin,
            generate_plugin_code,
            judge_plugin_code,
            diagnose_plugin_failure,
            get_secret,
            set_secret,
            delete_secret,
            list_secrets,
            fetch_genius_lyrics,
            web_search,
            web_search_openai,
            web_read,
            agent_write_file,
            agent_read_file,
            agent_list_directory,
            skill_list_summaries,
            skill_delete,
            oauth_flow,
            oauth_refresh,
            browser_command,
            browser_close,
            cua_run,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
