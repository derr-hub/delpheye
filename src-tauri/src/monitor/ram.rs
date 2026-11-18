//! Memory test in the running system: takes most of the free RAM, writes patterns into it and
//! reads every word back, over and over. A mismatch is a memory error — bad or overclocked RAM,
//! or an unstable memory controller.
//!
//! It cannot reach the memory Windows and other programs hold, so it is a strong check, not a
//! replacement for a boot-time tester such as Windows Memory Diagnostic or MemTest86.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// Memory is taken and tested in blocks of this many 64-bit words (64 MB).
const BLOCK: usize = 8 * 1024 * 1024;
/// Never leave Windows less than this, so the test does not push the system into paging.
const KEEP_FREE: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Default)]
pub struct RamStats {
    /// Memory taken for the test so far, in bytes.
    pub bytes: AtomicU64,
    /// Full write-and-verify passes over all blocks.
    pub passes: AtomicU64,
    pub errors: AtomicU64,
}

/// How much to test: 70 % of what is free now, leaving at least 2 GB to Windows.
pub fn target(available: u64) -> u64 {
    ((available as f64 * 0.7) as u64).min(available.saturating_sub(KEEP_FREE))
}

fn pattern(index: usize, seed: u64) -> u64 {
    let x = (index as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ seed;
    // Alternate the pattern and its inverse so every bit is tested both ways.
    if seed & 1 == 0 { x.rotate_left((index & 63) as u32) } else { !x.rotate_left((index & 63) as u32) }
}

/// Writes a pattern and reads it back; returns the number of words that came back wrong.
fn pass(block: &mut [u64], base: usize, seed: u64) -> u64 {
    // Volatile access so the compiler cannot skip the round trip through memory.
    for (i, cell) in block.iter_mut().enumerate() {
        // SAFETY: `cell` is a valid, exclusive reference into the block.
        unsafe { std::ptr::write_volatile(cell, pattern(base + i, seed)) };
    }
    let mut wrong = 0;
    for (i, cell) in block.iter().enumerate() {
        // SAFETY: as above.
        if unsafe { std::ptr::read_volatile(cell) } != pattern(base + i, seed) {
            wrong += 1;
        }
    }
    wrong
}

/// Starts `threads` workers sharing `bytes` of memory between them; they run until `stop`.
pub fn start(bytes: u64, threads: usize, stop: Arc<AtomicBool>, stats: Arc<RamStats>) -> Vec<std::thread::JoinHandle<()>> {
    let blocks = (bytes / (BLOCK as u64 * 8)) as usize;
    let threads = threads.clamp(1, blocks.max(1));
    (0..threads)
        .map(|worker| {
            let (stop, stats) = (stop.clone(), stats.clone());
            let mine = blocks / threads + usize::from(worker < blocks % threads);
            std::thread::spawn(move || {
                // Take memory a block at a time, so stopping early is quick.
                let mut owned: Vec<Vec<u64>> = Vec::new();
                for _ in 0..mine {
                    if stop.load(Ordering::Relaxed) {
                        return;
                    }
                    let mut block = Vec::new();
                    if block.try_reserve_exact(BLOCK).is_err() {
                        break;
                    }
                    block.resize(BLOCK, 0u64);
                    owned.push(block);
                    stats.bytes.fetch_add(BLOCK as u64 * 8, Ordering::Relaxed);
                }
                let mut seed: u64 = (worker as u64) << 48;
                while !stop.load(Ordering::Relaxed) {
                    for (n, block) in owned.iter_mut().enumerate() {
                        if stop.load(Ordering::Relaxed) {
                            return;
                        }
                        let wrong = pass(block, n * BLOCK, seed);
                        if wrong > 0 {
                            stats.errors.fetch_add(wrong, Ordering::Relaxed);
                        }
                    }
                    stats.passes.fetch_add(1, Ordering::Relaxed);
                    seed = seed.wrapping_add(1);
                }
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn the_target_leaves_windows_room() {
        let gb = 1024 * 1024 * 1024u64;
        assert_eq!(target(10 * gb), 7 * gb);
        assert_eq!(target(3 * gb), gb);
        assert_eq!(target(gb), 0);
    }

    #[test]
    fn a_healthy_block_passes_and_a_flipped_bit_is_caught() {
        let mut block = vec![0u64; 4096];
        assert_eq!(pass(&mut block, 0, 7), 0);
        assert_eq!(pass(&mut block, 0, 8), 0);
        // A word that does not hold what was written is an error.
        block[10] ^= 1;
        let wrong = block.iter().enumerate().filter(|(i, v)| **v != pattern(*i, 8)).count();
        assert_eq!(wrong, 1);
    }

    #[test]
    fn workers_take_memory_and_pass_cleanly() {
        let stop = Arc::new(AtomicBool::new(false));
        let stats = Arc::new(RamStats::default());
        let handles = start(256 * 1024 * 1024, 2, stop.clone(), stats.clone());
        let started = std::time::Instant::now();
        while stats.passes.load(Ordering::Relaxed) < 2 && started.elapsed() < Duration::from_secs(30) {
            std::thread::sleep(Duration::from_millis(50));
        }
        stop.store(true, Ordering::Relaxed);
        handles.into_iter().for_each(|h| h.join().unwrap());
        assert_eq!(stats.bytes.load(Ordering::Relaxed), 256 * 1024 * 1024);
        assert!(stats.passes.load(Ordering::Relaxed) >= 2);
        assert_eq!(stats.errors.load(Ordering::Relaxed), 0);
    }
}
