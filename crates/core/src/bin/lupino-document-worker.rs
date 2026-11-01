// Standalone entry point used by parser regression tests; the desktop uses its own early CLI branch.
fn main() {
    if let Err(error) = lupino_core::pdf_worker::run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
