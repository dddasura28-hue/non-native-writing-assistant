use non_native_writing_tsf_service::registration;
use std::path::PathBuf;

fn usage() -> &'static str {
    "Usage:\n  tsf-dev-register register <absolute-path-to-x64-dll>\n  tsf-dev-register unregister"
}

fn main() {
    let mut arguments = std::env::args_os().skip(1);
    let command = arguments.next();
    let result = match command.as_deref().and_then(|value| value.to_str()) {
        Some("register") => match (arguments.next(), arguments.next()) {
            (Some(path), None) => registration::register(&PathBuf::from(path)),
            _ => {
                eprintln!("{}", usage());
                std::process::exit(2);
            }
        },
        Some("unregister") if arguments.next().is_none() => registration::unregister(),
        _ => {
            eprintln!("{}", usage());
            std::process::exit(2);
        }
    };

    match result {
        Ok(report) => {
            for diagnostic in report.diagnostics {
                println!("{diagnostic}");
            }
            println!("TSF development registration command completed.");
        }
        Err(failure) => {
            for diagnostic in &failure.diagnostics {
                eprintln!("{diagnostic}");
            }
            eprintln!("{failure}");
            std::process::exit(1);
        }
    }
}
