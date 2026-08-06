//! Poison-tolerant lock accessors for the data plane's shared state.
//!
//! Rust marks a `Mutex`/`RwLock` POISONED once a thread panics while holding it, and every later `.unwrap()`
//! on that lock panics too. In a request-scoped, stateless proxy that is survivable — the panicking task is the
//! only casualty and axum keeps serving. It stops being survivable the moment long-lived tasks share this
//! state: one unlucky panic (a malformed manifest, an arithmetic edge) would convert a single failed stream
//! into a permanently dead process, because every subsequent request re-panics on the same poisoned lock.
//!
//! Every structure these guard is a CACHE or an OBSERVATIONAL SET — policies, resolved targets, host
//! allowlists, auth decisions. None of them carries an invariant that a mid-write panic could leave
//! meaningfully "corrupt": the worst case is a half-updated map that the next resolve overwrites anyway. So
//! recovering the inner value is strictly better than aborting the process.
//!
//! Deliberately NOT a blanket replacement policy: if a future structure does carry a real invariant across a
//! write, it should use its own type that makes the invariant unbreakable rather than reaching for these.

use std::sync::{Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard};

pub(crate) trait LockExt<T> {
    /// `lock()`, recovering the guard if the lock was poisoned by a panicking holder.
    fn lock_ok(&self) -> MutexGuard<'_, T>;
}

impl<T> LockExt<T> for Mutex<T> {
    fn lock_ok(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|e| e.into_inner())
    }
}

pub(crate) trait RwExt<T> {
    /// `read()`, recovering the guard if the lock was poisoned by a panicking holder.
    fn read_ok(&self) -> RwLockReadGuard<'_, T>;
    /// `write()`, recovering the guard if the lock was poisoned by a panicking holder.
    fn write_ok(&self) -> RwLockWriteGuard<'_, T>;
}

impl<T> RwExt<T> for RwLock<T> {
    fn read_ok(&self) -> RwLockReadGuard<'_, T> {
        self.read().unwrap_or_else(|e| e.into_inner())
    }

    fn write_ok(&self) -> RwLockWriteGuard<'_, T> {
        self.write().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn mutex_recovers_after_poison() {
        let m = Arc::new(Mutex::new(7u32));
        let m2 = m.clone();
        // Panic while holding the lock → the Mutex is poisoned from here on.
        let _ = std::thread::spawn(move || {
            let _g = m2.lock().unwrap();
            panic!("poison it");
        })
        .join();
        assert!(m.lock().is_err(), "precondition: the lock really is poisoned");
        assert_eq!(*m.lock_ok(), 7, "lock_ok recovers the inner value");
    }

    #[test]
    fn rwlock_recovers_after_poison() {
        let l = Arc::new(RwLock::new(vec![1u8, 2, 3]));
        let l2 = l.clone();
        let _ = std::thread::spawn(move || {
            let _g = l2.write().unwrap();
            panic!("poison it");
        })
        .join();
        assert!(l.write().is_err(), "precondition: the lock really is poisoned");
        assert_eq!(l.read_ok().len(), 3);
        l.write_ok().push(4);
        assert_eq!(l.read_ok().len(), 4);
    }
}
