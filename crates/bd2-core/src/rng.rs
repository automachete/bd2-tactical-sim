use serde::{Deserialize, Serialize};

/// Small, portable PRNG with an explicitly serialized state.
///
/// SplitMix64 is used because its output is fully specified and identical on
/// every supported platform. It is not used for cryptography.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeterministicRng {
    state: u64,
    draws: u64,
}

impl DeterministicRng {
    pub const fn new(seed: u64) -> Self {
        Self {
            state: seed,
            draws: 0,
        }
    }

    pub const fn draws(&self) -> u64 {
        self.draws
    }

    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        self.draws += 1;
        z ^ (z >> 31)
    }

    /// Uniform integer in `[0, upper)` without modulo bias.
    pub fn below(&mut self, upper: u64) -> u64 {
        assert!(upper > 0);
        let threshold = upper.wrapping_neg() % upper;
        loop {
            let value = self.next_u64();
            if value >= threshold {
                return value % upper;
            }
        }
    }

    pub fn roll_basis_points(&mut self, chance_bp: i32) -> (u64, bool) {
        let draw_id = self.draws;
        let result =
            chance_bp >= 10_000 || (chance_bp > 0 && self.below(10_000) < chance_bp as u64);
        (draw_id, result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_is_stable() {
        let mut rng = DeterministicRng::new(42);
        assert_eq!(rng.next_u64(), 13_679_457_532_755_275_413);
        assert_eq!(rng.next_u64(), 2_949_826_092_126_892_291);
        assert_eq!(rng.draws(), 2);
    }

    #[test]
    fn clone_resumes_exact_stream() {
        let mut left = DeterministicRng::new(7);
        left.next_u64();
        let mut right = left;
        assert_eq!(left.next_u64(), right.next_u64());
    }
}
