use std::sync::atomic::{AtomicUsize, Ordering};

static LIVE_OBJECTS: AtomicUsize = AtomicUsize::new(0);
static SERVER_LOCKS: AtomicUsize = AtomicUsize::new(0);

#[derive(Debug)]
pub(crate) struct ModuleObject;

impl ModuleObject {
    pub(crate) fn new() -> Self {
        LIVE_OBJECTS.fetch_add(1, Ordering::SeqCst);
        Self
    }
}

impl Drop for ModuleObject {
    fn drop(&mut self) {
        LIVE_OBJECTS.fetch_sub(1, Ordering::SeqCst);
    }
}

pub(crate) fn set_server_lock(locked: bool) {
    if locked {
        SERVER_LOCKS.fetch_add(1, Ordering::SeqCst);
        return;
    }

    let _ = SERVER_LOCKS.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
        value.checked_sub(1)
    });
}

pub(crate) fn can_unload() -> bool {
    LIVE_OBJECTS.load(Ordering::SeqCst) == 0 && SERVER_LOCKS.load(Ordering::SeqCst) == 0
}

#[cfg(test)]
pub(crate) fn counts() -> (usize, usize) {
    (
        LIVE_OBJECTS.load(Ordering::SeqCst),
        SERVER_LOCKS.load(Ordering::SeqCst),
    )
}

#[cfg(test)]
pub(crate) fn test_lock() -> std::sync::MutexGuard<'static, ()> {
    use std::sync::{Mutex, OnceLock};
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn objects_and_server_locks_gate_unload() {
        let _guard = test_lock();
        let baseline = counts();
        let object = ModuleObject::new();
        assert_eq!(counts().0, baseline.0 + 1);
        set_server_lock(true);
        assert_eq!(counts().1, baseline.1 + 1);
        set_server_lock(false);
        drop(object);
        assert_eq!(counts(), baseline);
    }
}
