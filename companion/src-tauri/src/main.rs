// The desktop entry point, used only to try the interface on a computer.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    companion_lib::run()
}
