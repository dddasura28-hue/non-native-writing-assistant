use crate::capture::{capture_context, NativeTextSnapshot};
use crate::diagnostics::{emit, Event};
use crate::lifetime::{set_server_lock, ModuleObject};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::rc::Rc;
use std::sync::{Mutex, MutexGuard};
use std::thread::ThreadId;
use windows::core::{implement, Error, IUnknown, IUnknownImpl, Interface, Ref, Result, BOOL};
use windows::Win32::Foundation::{CLASS_E_NOAGGREGATION, E_FAIL, E_POINTER, E_UNEXPECTED};
use windows::Win32::System::Com::{IClassFactory, IClassFactory_Impl};
use windows::Win32::UI::TextServices::{
    ITfContext, ITfDocumentMgr, ITfEditRecord, ITfEditSession, ITfEditSession_Impl, ITfSource,
    ITfTextEditSink, ITfTextEditSink_Impl, ITfTextInputProcessorEx, ITfTextInputProcessorEx_Impl,
    ITfTextInputProcessor_Impl, ITfThreadMgr, ITfThreadMgrEventSink, ITfThreadMgrEventSink_Impl,
    TF_ES_ASYNC, TF_ES_READ, TF_TMAE_SECUREMODE,
};

fn error(code: windows::core::HRESULT) -> Error {
    Error::from_hresult(code)
}

fn ffi_guard<T>(operation: impl FnOnce() -> Result<T>) -> Result<T> {
    catch_unwind(AssertUnwindSafe(operation)).unwrap_or_else(|_| Err(error(E_UNEXPECTED)))
}

#[derive(Default)]
struct SinkBinding {
    source: Option<ITfSource>,
    cookie: Option<u32>,
}

impl SinkBinding {
    fn take(&mut self) -> Self {
        Self {
            source: self.source.take(),
            cookie: self.cookie.take(),
        }
    }

    fn unadvise(self) {
        if let (Some(source), Some(cookie)) = (self.source, self.cookie) {
            let _ = unsafe { source.UnadviseSink(cookie) };
        }
    }
}

#[derive(Default)]
struct ServiceState {
    active: bool,
    secure: bool,
    owner_thread: Option<ThreadId>,
    client_id: u32,
    generation: u64,
    thread_manager: Option<ITfThreadMgr>,
    document_manager: Option<ITfDocumentMgr>,
    context: Option<ITfContext>,
    thread_sink: SinkBinding,
    text_sink: SinkBinding,
}

impl ServiceState {
    fn initialize_activation(&mut self, client_id: u32, secure: bool) -> Result<u64> {
        if self.active {
            return Err(error(E_UNEXPECTED));
        }
        self.active = true;
        self.secure = secure;
        self.owner_thread = Some(std::thread::current().id());
        self.client_id = client_id;
        self.generation = self.generation.wrapping_add(1);
        Ok(self.generation)
    }

    fn begin_activation(
        &mut self,
        client_id: u32,
        secure: bool,
        manager: ITfThreadMgr,
    ) -> Result<u64> {
        let generation = self.initialize_activation(client_id, secure)?;
        self.thread_manager = Some(manager);
        Ok(generation)
    }

    fn next_generation(&mut self) -> u64 {
        self.generation = self.generation.wrapping_add(1);
        self.generation
    }

    fn is_current(
        &self,
        document_identity: usize,
        context: &ITfContext,
        generation: u64,
        owner_thread: ThreadId,
    ) -> bool {
        self.is_current_identity(
            document_identity,
            context.as_raw() as usize,
            generation,
            owner_thread,
        )
    }

    fn is_current_identity(
        &self,
        document_identity: usize,
        context_identity: usize,
        generation: u64,
        owner_thread: ThreadId,
    ) -> bool {
        let current = self
            .owner_thread
            .zip(
                self.document_manager
                    .as_ref()
                    .map(|current| current.as_raw() as usize),
            )
            .zip(
                self.context
                    .as_ref()
                    .map(|current| current.as_raw() as usize),
            )
            .map(|((thread, document), context)| NativeIdentity {
                document,
                context,
                generation: self.generation,
                thread,
            });
        callback_identity_is_current(
            self.active,
            self.secure,
            current,
            NativeIdentity {
                document: document_identity,
                context: context_identity,
                generation,
                thread: owner_thread,
            },
        )
    }

    fn clear(&mut self) -> (u64, SinkBinding, SinkBinding) {
        self.active = false;
        self.secure = false;
        self.owner_thread = None;
        self.client_id = 0;
        let generation = self.next_generation();
        self.thread_manager = None;
        self.document_manager = None;
        self.context = None;
        let thread_sink = self.thread_sink.take();
        let text_sink = self.text_sink.take();
        (generation, thread_sink, text_sink)
    }
}

type SharedState = Rc<Mutex<ServiceState>>;

fn lock_state(shared: &SharedState) -> Result<MutexGuard<'_, ServiceState>> {
    shared.lock().map_err(|_| error(E_FAIL))
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct NativeIdentity {
    document: usize,
    context: usize,
    generation: u64,
    thread: ThreadId,
}

fn callback_identity_is_current(
    active: bool,
    secure: bool,
    current: Option<NativeIdentity>,
    callback: NativeIdentity,
) -> bool {
    active && !secure && current == Some(callback)
}

#[implement(IClassFactory)]
pub(crate) struct TextServiceClassFactory {
    _module: ModuleObject,
}

impl TextServiceClassFactory {
    pub(crate) fn new() -> Self {
        Self {
            _module: ModuleObject::new(),
        }
    }
}

impl IClassFactory_Impl for TextServiceClassFactory_Impl {
    fn CreateInstance(
        &self,
        outer: Ref<'_, IUnknown>,
        riid: *const windows::core::GUID,
        object: *mut *mut core::ffi::c_void,
    ) -> Result<()> {
        ffi_guard(|| {
            if !outer.is_null() {
                return Err(error(CLASS_E_NOAGGREGATION));
            }
            if riid.is_null() || object.is_null() {
                return Err(error(E_POINTER));
            }
            unsafe { object.write(std::ptr::null_mut()) };
            let service: ITfTextInputProcessorEx = TextService::new().into();
            let result = unsafe { service.query(riid, object) };
            result.ok()
        })
    }

    fn LockServer(&self, lock: BOOL) -> Result<()> {
        ffi_guard(|| {
            set_server_lock(lock.as_bool());
            Ok(())
        })
    }
}

#[implement(ITfTextInputProcessorEx, ITfThreadMgrEventSink, ITfTextEditSink)]
struct TextService {
    _module: ModuleObject,
    shared: SharedState,
}

impl TextService {
    fn new() -> Self {
        Self {
            _module: ModuleObject::new(),
            shared: Rc::new(Mutex::new(ServiceState::default())),
        }
    }
}

impl TextService_Impl {
    fn activate_inner(&self, manager: ITfThreadMgr, client_id: u32, flags: u32) -> Result<()> {
        let secure = flags & TF_TMAE_SECUREMODE != 0;
        let generation = {
            let mut state = lock_state(&self.shared)?;
            state.begin_activation(client_id, secure, manager.clone())?
        };
        emit(Event::Activated { secure, generation });
        if secure {
            return Ok(());
        }

        let activation = (|| {
            let source: ITfSource = manager.cast()?;
            let sink: ITfThreadMgrEventSink = self.to_interface();
            let cookie = unsafe { source.AdviseSink(&ITfThreadMgrEventSink::IID, &sink)? };
            {
                let mut state = lock_state(&self.shared)?;
                state.thread_sink = SinkBinding {
                    source: Some(source),
                    cookie: Some(cookie),
                };
            }
            self.attach_focused_document(&manager)
        })();

        if activation.is_err() {
            let _ = self.deactivate_inner();
        }
        activation
    }

    fn deactivate_inner(&self) -> Result<()> {
        let (generation, thread_sink, text_sink) = {
            let mut state = lock_state(&self.shared)?;
            state.clear()
        };
        text_sink.unadvise();
        thread_sink.unadvise();
        emit(Event::Deactivated { generation });
        Ok(())
    }

    fn attach_focused_document(&self, manager: &ITfThreadMgr) -> Result<()> {
        match unsafe { manager.GetFocus() } {
            Ok(document) => self.attach_document(Some(document)),
            Err(_) => self.attach_document(None),
        }
    }

    fn attach_document(&self, document: Option<ITfDocumentMgr>) -> Result<()> {
        let context = document
            .as_ref()
            .and_then(|document| unsafe { document.GetTop().ok() });
        self.attach_context(document, context)
    }

    fn attach_context(
        &self,
        document: Option<ITfDocumentMgr>,
        context: Option<ITfContext>,
    ) -> Result<()> {
        let old_binding = {
            let mut state = lock_state(&self.shared)?;
            if !state.active || state.secure {
                return Ok(());
            }
            if state
                .context
                .as_ref()
                .zip(context.as_ref())
                .is_some_and(|(old, new)| old.as_raw() == new.as_raw())
            {
                state.document_manager = document;
                return Ok(());
            }
            state.document_manager = document;
            state.context = context.clone();
            let generation = state.next_generation();
            emit(Event::ContextChanged { generation });
            state.text_sink.take()
        };
        old_binding.unadvise();

        let Some(context) = context else {
            return Ok(());
        };
        let source: ITfSource = context.cast()?;
        let sink: ITfTextEditSink = self.to_interface();
        let cookie = unsafe { source.AdviseSink(&ITfTextEditSink::IID, &sink)? };
        let generation = {
            let mut state = lock_state(&self.shared)?;
            if !state.active
                || state
                    .context
                    .as_ref()
                    .is_none_or(|current| current.as_raw() != context.as_raw())
            {
                drop(state);
                let _ = unsafe { source.UnadviseSink(cookie) };
                return Ok(());
            }
            state.text_sink = SinkBinding {
                source: Some(source),
                cookie: Some(cookie),
            };
            state.generation
        };
        self.request_capture(context, generation)
    }

    fn request_capture(&self, context: ITfContext, generation: u64) -> Result<()> {
        let (client_id, owner_thread, document_identity) = {
            let state = lock_state(&self.shared)?;
            if !state.active || state.secure || state.generation != generation {
                return Ok(());
            }
            let Some(owner_thread) = state.owner_thread else {
                return Ok(());
            };
            let Some(document_identity) = state
                .document_manager
                .as_ref()
                .map(|document| document.as_raw() as usize)
            else {
                return Ok(());
            };
            (state.client_id, owner_thread, document_identity)
        };
        let session: ITfEditSession = ReadEditSession {
            _module: ModuleObject::new(),
            shared: Rc::clone(&self.shared),
            context: context.clone(),
            document_identity,
            generation,
            owner_thread,
        }
        .into();
        let session_result =
            unsafe { context.RequestEditSession(client_id, &session, TF_ES_READ | TF_ES_ASYNC) }?;
        if session_result.is_err() {
            return Err(Error::from_hresult(session_result));
        }
        Ok(())
    }

    fn note_text_edit(&self, context: ITfContext) -> Result<()> {
        let generation = {
            let mut state = lock_state(&self.shared)?;
            if !state.active
                || state.secure
                || state
                    .context
                    .as_ref()
                    .is_none_or(|current| current.as_raw() != context.as_raw())
            {
                return Ok(());
            }
            state.next_generation()
        };
        self.request_capture(context, generation)
    }
}

impl ITfTextInputProcessor_Impl for TextService_Impl {
    fn Activate(&self, manager: Ref<'_, ITfThreadMgr>, client_id: u32) -> Result<()> {
        ffi_guard(|| {
            let manager = manager.cloned().ok_or_else(|| error(E_POINTER))?;
            self.activate_inner(manager, client_id, 0)
        })
    }

    fn Deactivate(&self) -> Result<()> {
        ffi_guard(|| self.deactivate_inner())
    }
}

impl ITfTextInputProcessorEx_Impl for TextService_Impl {
    fn ActivateEx(&self, manager: Ref<'_, ITfThreadMgr>, client_id: u32, flags: u32) -> Result<()> {
        ffi_guard(|| {
            let manager = manager.cloned().ok_or_else(|| error(E_POINTER))?;
            self.activate_inner(manager, client_id, flags)
        })
    }
}

impl ITfThreadMgrEventSink_Impl for TextService_Impl {
    fn OnInitDocumentMgr(&self, _document: Ref<'_, ITfDocumentMgr>) -> Result<()> {
        ffi_guard(|| {
            let generation = lock_state(&self.shared)?.generation;
            emit(Event::DocumentInitialized { generation });
            Ok(())
        })
    }

    fn OnUninitDocumentMgr(&self, document: Ref<'_, ITfDocumentMgr>) -> Result<()> {
        ffi_guard(|| {
            let should_detach = {
                let state = lock_state(&self.shared)?;
                document.as_ref().is_some_and(|document| {
                    state
                        .document_manager
                        .as_ref()
                        .is_some_and(|current| current.as_raw() == document.as_raw())
                })
            };
            if should_detach {
                self.attach_context(None, None)?;
            }
            let generation = lock_state(&self.shared)?.generation;
            emit(Event::DocumentUninitialized {
                generation,
                was_current: should_detach,
            });
            Ok(())
        })
    }

    fn OnSetFocus(
        &self,
        document: Ref<'_, ITfDocumentMgr>,
        _previous: Ref<'_, ITfDocumentMgr>,
    ) -> Result<()> {
        ffi_guard(|| self.attach_document(document.cloned()))
    }

    fn OnPushContext(&self, context: Ref<'_, ITfContext>) -> Result<()> {
        ffi_guard(|| {
            let Some(context) = context.cloned() else {
                return Ok(());
            };
            let document = unsafe { context.GetDocumentMgr().ok() };
            self.attach_context(document, Some(context))
        })
    }

    fn OnPopContext(&self, _context: Ref<'_, ITfContext>) -> Result<()> {
        ffi_guard(|| {
            let manager = { lock_state(&self.shared)?.thread_manager.clone() };
            if let Some(manager) = manager {
                self.attach_focused_document(&manager)?;
            }
            Ok(())
        })
    }
}

impl ITfTextEditSink_Impl for TextService_Impl {
    fn OnEndEdit(
        &self,
        context: Ref<'_, ITfContext>,
        _read_only_cookie: u32,
        _record: Ref<'_, ITfEditRecord>,
    ) -> Result<()> {
        ffi_guard(|| {
            let Some(context) = context.cloned() else {
                return Ok(());
            };
            if self.note_text_edit(context).is_err() {
                let generation = lock_state(&self.shared)
                    .map(|state| state.generation)
                    .unwrap_or(0);
                emit(Event::CaptureSkipped {
                    generation,
                    reason: "request-edit-session-failed",
                });
            }
            Ok(())
        })
    }
}

#[implement(ITfEditSession)]
struct ReadEditSession {
    _module: ModuleObject,
    shared: SharedState,
    context: ITfContext,
    document_identity: usize,
    generation: u64,
    owner_thread: ThreadId,
}

impl ITfEditSession_Impl for ReadEditSession_Impl {
    fn DoEditSession(&self, edit_cookie: u32) -> Result<()> {
        ffi_guard(|| {
            let callback_thread = std::thread::current().id();
            let current = callback_thread == self.owner_thread
                && lock_state(&self.shared)?.is_current(
                    self.document_identity,
                    &self.context,
                    self.generation,
                    callback_thread,
                );
            if !current {
                emit(Event::CaptureSkipped {
                    generation: self.generation,
                    reason: "stale-session",
                });
                return Ok(());
            }

            match unsafe {
                capture_context(
                    &self.context,
                    edit_cookie,
                    self.document_identity,
                    self.generation,
                )
            } {
                Ok(snapshot) => emit_snapshot(&snapshot),
                Err(_) => emit(Event::CaptureSkipped {
                    generation: self.generation,
                    reason: "unsupported-or-unavailable-context",
                }),
            }
            Ok(())
        })
    }
}

fn emit_snapshot(snapshot: &NativeTextSnapshot) {
    let selection = snapshot.selection.unwrap_or(crate::capture::Utf16Range {
        start: snapshot.cursor_offset,
        end: snapshot.cursor_offset,
    });
    let composition = snapshot
        .composition
        .as_ref()
        .map(|composition| composition.range)
        .unwrap_or(crate::capture::Utf16Range { start: 0, end: 0 });
    emit(Event::Snapshot {
        generation: snapshot.session.generation,
        text_units: snapshot.text_utf16.len(),
        cursor: snapshot.cursor_offset,
        selection_start: selection.start,
        selection_end: selection.end,
        composition_start: composition.start,
        composition_end: composition.end,
        composition_active: snapshot.composition.is_some(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lifetime;

    #[test]
    fn class_factory_creates_required_processor_interfaces() {
        let _guard = lifetime::test_lock();
        let baseline = lifetime::counts();
        let factory: IClassFactory = TextServiceClassFactory::new().into();
        let extended: ITfTextInputProcessorEx = unsafe { factory.CreateInstance(None).unwrap() };
        let base: windows::Win32::UI::TextServices::ITfTextInputProcessor =
            extended.cast().unwrap();
        drop(base);
        drop(extended);
        drop(factory);
        assert_eq!(lifetime::counts(), baseline);
    }

    #[test]
    fn deactivation_state_clears_all_retained_com_identity() {
        let mut state = ServiceState {
            active: true,
            secure: true,
            client_id: 42,
            owner_thread: Some(std::thread::current().id()),
            generation: 9,
            ..Default::default()
        };
        state.thread_sink.cookie = Some(7);
        state.text_sink.cookie = Some(8);
        assert!(!state.is_current_identity(0x5678, 0x1234, 9, std::thread::current().id()));
        let (generation, _, _) = state.clear();
        assert_eq!(generation, 10);
        assert!(!state.active);
        assert!(!state.secure);
        assert_eq!(state.client_id, 0);
        assert!(state.owner_thread.is_none());
        assert!(state.thread_manager.is_none());
        assert!(state.document_manager.is_none());
        assert!(state.context.is_none());
        assert!(state.thread_sink.cookie.is_none());
        assert!(state.text_sink.cookie.is_none());
        assert!(!state.is_current_identity(0x5678, 0x1234, 10, std::thread::current().id()));
    }

    #[test]
    fn server_lock_keeps_module_loaded_after_factory_release() {
        let _guard = lifetime::test_lock();
        assert_eq!(crate::DllCanUnloadNow(), windows::Win32::Foundation::S_OK);
        let factory: IClassFactory = TextServiceClassFactory::new().into();
        unsafe { factory.LockServer(true).unwrap() };
        drop(factory);
        assert_eq!(
            crate::DllCanUnloadNow(),
            windows::Win32::Foundation::S_FALSE
        );

        let factory: IClassFactory = TextServiceClassFactory::new().into();
        unsafe { factory.LockServer(false).unwrap() };
        drop(factory);
        assert_eq!(crate::DllCanUnloadNow(), windows::Win32::Foundation::S_OK);
    }

    #[test]
    fn stale_or_secure_callbacks_are_rejected_by_native_identity() {
        let thread = std::thread::current().id();
        let current = NativeIdentity {
            document: 0x5678,
            context: 0x1234,
            generation: 5,
            thread,
        };
        assert!(callback_identity_is_current(
            true,
            false,
            Some(current),
            current,
        ));
        assert!(!callback_identity_is_current(
            true,
            false,
            Some(NativeIdentity {
                generation: 6,
                ..current
            }),
            current,
        ));
        assert!(!callback_identity_is_current(
            true,
            false,
            Some(NativeIdentity {
                context: 0x9999,
                ..current
            }),
            current,
        ));
        assert!(!callback_identity_is_current(
            true,
            true,
            Some(current),
            current,
        ));
        assert!(!callback_identity_is_current(
            false,
            false,
            Some(current),
            current,
        ));
    }

    #[test]
    fn activation_generation_initializes_once_and_duplicate_activation_rejects() {
        let mut state = ServiceState::default();
        let generation = state.initialize_activation(42, false).unwrap();
        assert_eq!(generation, 1);
        assert!(state.active);
        assert_eq!(state.client_id, 42);
        assert!(state.initialize_activation(42, false).is_err());
        assert_eq!(state.generation, 1);

        let (deactivated_generation, _, _) = state.clear();
        assert_eq!(deactivated_generation, 2);
        assert!(!state.active);
    }
}
