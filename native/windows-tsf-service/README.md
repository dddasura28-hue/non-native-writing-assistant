# Windows TSF Native Component Prototype v1

This directory builds a development-only x64 COM in-process text service. It is a passive,
read-only feasibility probe. It has no provider, network, IPC, UI, or text-mutation path and is not
loaded by the desktop app. The working UI Automation global assistant remains unchanged.

The DLL exposes `DllGetClassObject`, `DllCanUnloadNow`, a COM class factory, and
`ITfTextInputProcessorEx`/`ITfTextInputProcessor`. Activation observes thread-manager focus and
context changes, advises `ITfTextEditSink`, and requests short asynchronous `TF_ES_READ` edit
sessions. A session reads one contiguous selection plus bounded surrounding UTF-16 text and attempts
to observe one active composition through `GUID_PROP_COMPOSING` and `ITfContextComposition`.
Captured text is discarded when the edit session returns. `OutputDebugStringW` receives lengths,
offsets, generations, and safe reason codes only.

There is intentionally no custom `DllMain`; DLL load performs no application work. Secure-mode
activation disables all sink registration and capture. Every context or edit transition advances an
opaque generation, and a late edit-session callback is ignored unless its context, generation,
owning thread, and active state still match.

## Build and automated checks

Run these commands from the repository root in a normal, non-elevated PowerShell session:

```powershell
cargo test --manifest-path .\native\windows-tsf-service\Cargo.toml
cargo check --manifest-path .\native\windows-tsf-service\Cargo.toml --all-targets
cargo fmt --manifest-path .\native\windows-tsf-service\Cargo.toml -- --check
cargo build --manifest-path .\native\windows-tsf-service\Cargo.toml --release --target x86_64-pc-windows-msvc
```

The real x64 artifacts are:

```text
native\windows-tsf-service\target\x86_64-pc-windows-msvc\release\non_native_writing_tsf_service.dll
native\windows-tsf-service\target\x86_64-pc-windows-msvc\release\tsf-dev-register.exe
```

Builds and tests never register the service. The desktop app, Tauri startup, pnpm scripts, and CI do
not invoke the registration tool.

## Explicit development registration

Registration is machine-level because the x64 COM server is written under
`HKLM\Software\Classes\CLSID`. Use an elevated PowerShell only for this deliberate manual step.
The tool registers two development profiles (English `0x0409` and Simplified Chinese `0x0804`) and
the prototype `GUID_TFCAT_TIP_KEYBOARD` category. It enables the profiles so Windows can present
them, but it does not activate one, change the default input method, or switch away from Microsoft
Pinyin.

```powershell
$dll = (Resolve-Path .\native\windows-tsf-service\target\x86_64-pc-windows-msvc\release\non_native_writing_tsf_service.dll).Path
& .\native\windows-tsf-service\target\x86_64-pc-windows-msvc\release\tsf-dev-register.exe register $dll
```

The registration implementation uses the standard COM `InprocServer32` value with
`ThreadingModel=Apartment`, `ITfInputProcessorProfiles` for the service and profiles, and
`ITfCategoryMgr` for the one development category. If registration fails partway, run the rollback
command below before retrying.

## Manual proof procedure

1. Start Sysinternals DebugView, WinDbg, or another debugger that displays
   `OutputDebugStringW`. Filter on `[non-native-writing-tsf]`. The messages deliberately contain no
   source or composition text.
2. Complete the explicit registration above. Close and reopen each x64 test application so TSF can
   discover the profile.
3. In x64 Notepad, use the Windows input switcher to select **Non-native Writing TSF Prototype
   (Development) — English**. Type ordinary English, make a selection, move the caret, and type
   multiline text. Confirm activation, context-change, and snapshot metadata appears. Confirm no
   captured text appears in the debugger.
4. Repeat with mixed Chinese/English text and `A😀B`. Verify reported offsets and lengths behave as
   UTF-16 code units (the emoji occupies two units) and the application text is never changed.
5. Select **Non-native Writing TSF Prototype (Development) — Chinese** and repeat the capture check.
6. Test a secure or password control. The acceptable result is no snapshot event. Record whether
   Windows activated the service with `secure=true`; lack of that signal in a protected host remains
   a fail-closed design question rather than proof of safety.
7. For the central coexistence question, select Microsoft Pinyin and begin, update, commit, and
   cancel compositions in Notepad and at least one other x64 TSF-aware editor. Watch whether this
   prototype remains activated and reports `composition_active=true` with the expected range while Pinyin owns the
   composition. If Windows deactivates this keyboard TIP when Pinyin becomes active, record the
   result as **passive observation not viable with this category**. Do not treat observation of the
   prototype's own selected profile as proof that it can observe another IME.
8. Switch focus between two editable controls and close the test application. Confirm context
   generations advance, late sessions report `stale-session`, and no callbacks appear after
   deactivation.
9. Repeat representative checks in another x64 application. An x86 application cannot load this
   DLL and is outside this prototype.

This procedure is the only way to answer whether the service can coexist with Microsoft Pinyin and
passively observe its composition. A successful build or class-factory test does not answer it.

## Exact rollback

First switch back to the user's preferred input method. Then run this command from an elevated
PowerShell session:

```powershell
& .\native\windows-tsf-service\target\x86_64-pc-windows-msvc\release\tsf-dev-register.exe unregister
```

The command disables and removes both development language profiles, removes the keyboard category,
unregisters the TSF service, and deletes only this prototype's x64 COM CLSID tree. Close and reopen
test applications, then confirm the two development profiles no longer appear in the Windows input
switcher. The tool does not alter Microsoft Pinyin or any unrelated profile.

This unsigned development DLL is not suitable for distribution. Production deployment would need
code signing, installer ownership, x86 and ARM64 artifacts where supported, compatibility and secure
field testing, and a proven activation/category model.
