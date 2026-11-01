use std::{collections::HashMap, sync::Mutex};
/// Reservation precedes spawning, so cancel also covers a process that has not started yet.
pub struct Workers<T>(Mutex<HashMap<String, Option<T>>>);
impl<T> Default for Workers<T> {
    fn default() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}
impl<T: Clone> Workers<T> {
    pub fn reserve(&self, id: &str) -> bool {
        let mut entries = self.0.lock().unwrap();
        if entries.contains_key(id) {
            return false;
        }
        entries.insert(id.into(), None);
        true
    }
    pub fn contains(&self, id: &str) -> bool {
        self.0.lock().unwrap().contains_key(id)
    }
    pub fn attach(&self, id: &str, child: T) -> bool {
        let mut entries = self.0.lock().unwrap();
        let Some(slot) = entries.get_mut(id) else {
            return false;
        };
        *slot = Some(child);
        true
    }
    pub fn remove(&self, id: &str) -> Option<T> {
        self.0.lock().unwrap().remove(id).flatten()
    }
    pub fn children(&self) -> Vec<T> {
        self.0.lock().unwrap().values().flatten().cloned().collect()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancelled_reservation_cannot_start_late() {
        let workers = Workers::default();
        assert!(workers.reserve("a"));
        assert!(!workers.reserve("a"));
        assert_eq!(workers.remove("a"), None);
        assert!(!workers.attach("a", 42));
        assert!(workers.children().is_empty());
    }
    #[test]
    fn attached_process_is_returned_for_termination() {
        let workers = Workers::default();
        assert!(workers.reserve("a"));
        assert!(workers.attach("a", 42));
        assert_eq!(workers.remove("a"), Some(42));
        assert!(!workers.contains("a"));
    }
}
