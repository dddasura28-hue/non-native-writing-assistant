fn main() {
    if std::env::var("CARGO_CFG_WINDOWS").is_ok() {
        let definition =
            std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("exports.def");
        println!("cargo:rerun-if-changed={}", definition.display());
        println!("cargo:rustc-cdylib-link-arg=/DEF:{}", definition.display());
    }
}
