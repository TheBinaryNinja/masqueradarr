
use std::sync::{Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard};

pub(crate) trait LockExt<T> {
    fn lock_ok(&self) -> MutexGuard<'_, T>;
}

impl<T> LockExt<T> for Mutex<T> {
    fn lock_ok(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|e| e.into_inner())
    }
}

pub(crate) trait RwExt<T> {
    fn read_ok(&self) -> RwLockReadGuard<'_, T>;
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
