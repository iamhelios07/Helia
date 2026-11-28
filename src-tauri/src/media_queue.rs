use super::{Duration, Failure, Instant, Result};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Condvar, LazyLock, Mutex},
};

pub(super) static WRITES: LazyLock<Queue> = LazyLock::new(|| Queue::new(8, 4));
pub(super) static HASHES: LazyLock<Queue> = LazyLock::new(|| Queue::new(2, 2));
#[derive(Default)]
struct State {
    next: u64,
    waiters: VecDeque<(u64, String)>,
    active: usize,
    games: HashMap<String, usize>,
}
pub(super) struct Queue {
    max: usize,
    per_game: usize,
    state: Mutex<State>,
    changed: Condvar,
}
pub(super) struct Permit<'a> {
    queue: &'a Queue,
    game: String,
}
impl Queue {
    pub(super) fn new(max: usize, per_game: usize) -> Self {
        Self {
            max,
            per_game,
            state: Mutex::default(),
            changed: Condvar::new(),
        }
    }
    pub(super) fn acquire(&self, game: &str, timeout: Duration) -> Result<Permit<'_>> {
        let end = Instant::now() + timeout;
        let mut state = self.state.lock().map_err(|_| Failure("busy"))?;
        let id = state.next;
        state.next += 1;
        state.waiters.push_back((id, game.into()));
        loop {
            let eligible = state
                .waiters
                .iter()
                .find(|(_, g)| state.games.get(g).copied().unwrap_or(0) < self.per_game);
            if state.active < self.max && eligible.is_some_and(|(i, _)| *i == id) {
                state.waiters.retain(|(i, _)| *i != id);
                state.active += 1;
                *state.games.entry(game.into()).or_default() += 1;
                self.changed.notify_all();
                return Ok(Permit {
                    queue: self,
                    game: game.into(),
                });
            }
            let (next, wait) = self
                .changed
                .wait_timeout(state, end.saturating_duration_since(Instant::now()))
                .map_err(|_| Failure("busy"))?;
            state = next;
            if wait.timed_out() || Instant::now() >= end {
                state.waiters.retain(|(i, _)| *i != id);
                self.changed.notify_all();
                return Err(Failure("busy"));
            }
        }
    }
}
impl Drop for Permit<'_> {
    fn drop(&mut self) {
        let mut state = self.queue.state.lock().unwrap();
        state.active -= 1;
        let count = state.games.get_mut(&self.game).unwrap();
        *count -= 1;
        if *count == 0 {
            state.games.remove(&self.game);
        }
        self.queue.changed.notify_all();
    }
}
