mod commands;
mod memory;
mod wake_word;

use commands::*;
use memory::*;
use wake_word::*;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            commands::cleanup_temp_files();

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
            capture_page,
            capture_screen,
            capture_active_window,
            analyze_page,
            focus_book,
            next_page,
            prev_page,
            scroll_down,
            search_book,
            computer_use_task,
            get_config,
            transcribe_audio,
            list_displays,
            set_default_display,
            start_recording,
            stop_recording,
            analyze_recording,
            check_screen_for_language,
            check_audio_for_language,
            get_attention_state,
            triage_observation,
            start_learning_audio,
            stop_learning_audio,
            check_learning_audio,
            memory_get_context,
            memory_set_fact,
            memory_mark_known,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
