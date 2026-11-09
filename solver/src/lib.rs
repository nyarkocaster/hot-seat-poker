// Hot Seat Poker solver: a WebAssembly wrapper around postflop-solver.
//
// Based on the wrapper in WASM Postflop (https://github.com/b-inary/wasm-postflop),
// Copyright (C) 2022 Wataru Inariba, licensed under the GNU Affero General Public License
// v3.0 or later. Changes for Hot Seat Poker: ranges are passed as text, bet sizes are shared
// by both players per street, and a few convenience functions were added.
//
// This program is free software: you can redistribute it and/or modify it under the terms of
// the GNU Affero General Public License as published by the Free Software Foundation, either
// version 3 of the License, or (at your option) any later version. See the LICENSE file.

use postflop_solver::*;
use wasm_bindgen::prelude::*;

#[cfg(feature = "mt")]
mod rayon_adapter;

#[wasm_bindgen]
pub struct Solver {
    game: PostFlopGame,
}

#[inline]
fn round(value: f64) -> f64 {
    if value < 1.0 {
        (value * 1000000.0).round() / 1000000.0
    } else if value < 10.0 {
        (value * 100000.0).round() / 100000.0
    } else if value < 100.0 {
        (value * 10000.0).round() / 10000.0
    } else if value < 1000.0 {
        (value * 1000.0).round() / 1000.0
    } else if value < 10000.0 {
        (value * 100.0).round() / 100.0
    } else {
        (value * 10.0).round() / 10.0
    }
}

#[inline]
fn round_iter<'a>(iter: impl Iterator<Item = &'a f32> + 'a) -> impl Iterator<Item = f64> + 'a {
    iter.map(|&x| round(x as f64))
}

/// Runs `op` on the thread pool when the multi-threaded build has one.
#[inline]
#[allow(static_mut_refs)]
fn in_pool<R: Send, OP: FnOnce() -> R + Send>(op: OP) -> R {
    #[cfg(feature = "mt")]
    unsafe {
        if let Some(pool) = rayon_adapter::THREAD_POOL.as_ref() {
            return pool.install(op);
        }
    }
    op()
}

#[wasm_bindgen]
impl Solver {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self { game: PostFlopGame::new() }
    }

    /// Sets up a spot. Amounts are integers (the page uses cents). Bet sizes use the
    /// postflop-solver syntax, e.g. "33%, 75%" for bets and "3x" for raises; "e" (geometric)
    /// and "a" (all-in) are allowed too. Returns an error message, or None on success.
    #[allow(clippy::too_many_arguments)]
    pub fn init(
        &mut self,
        oop_range: &str,
        ip_range: &str,
        board: &[u8],
        starting_pot: i32,
        effective_stack: i32,
        rake_rate: f64,
        rake_cap: f64,
        flop_bet: &str,
        flop_raise: &str,
        turn_bet: &str,
        turn_raise: &str,
        river_bet: &str,
        river_raise: &str,
        add_allin_threshold: f64,
        force_allin_threshold: f64,
        merging_threshold: f64,
    ) -> Option<String> {
        let oop: Range = match oop_range.parse() {
            Ok(r) => r,
            Err(e) => return Some(format!("Out-of-position range: {e}")),
        };
        let ip: Range = match ip_range.parse() {
            Ok(r) => r,
            Err(e) => return Some(format!("In-position range: {e}")),
        };
        if board.len() < 3 || board.len() > 5 || board.iter().any(|&c| c >= 52) {
            return Some("The board needs 3 to 5 cards.".to_string());
        }
        let (turn, river, state) = match board.len() {
            3 => (NOT_DEALT, NOT_DEALT, BoardState::Flop),
            4 => (board[3], NOT_DEALT, BoardState::Turn),
            _ => (board[3], board[4], BoardState::River),
        };
        if starting_pot <= 0 || effective_stack <= 0 {
            return Some("The pot and the effective stack must be above zero.".to_string());
        }
        let sizes = |bet: &str, raise: &str, street: &str| {
            BetSizeOptions::try_from((bet, raise)).map_err(|e| format!("{street} bet sizes: {e}"))
        };
        let flop = match sizes(flop_bet, flop_raise, "Flop") { Ok(s) => s, Err(e) => return Some(e) };
        let turn_s = match sizes(turn_bet, turn_raise, "Turn") { Ok(s) => s, Err(e) => return Some(e) };
        let river_s = match sizes(river_bet, river_raise, "River") { Ok(s) => s, Err(e) => return Some(e) };

        let card_config = CardConfig {
            range: [oop, ip],
            flop: [board[0], board[1], board[2]],
            turn,
            river,
        };
        let tree_config = TreeConfig {
            initial_state: state,
            starting_pot,
            effective_stack,
            rake_rate,
            rake_cap,
            flop_bet_sizes: [flop.clone(), flop],
            turn_bet_sizes: [turn_s.clone(), turn_s],
            river_bet_sizes: [river_s.clone(), river_s],
            turn_donk_sizes: None,
            river_donk_sizes: None,
            add_allin_threshold,
            force_allin_threshold,
            merging_threshold,
        };
        let action_tree = match ActionTree::new(tree_config) {
            Ok(t) => t,
            Err(e) => return Some(e),
        };
        self.game.update_config(card_config, action_tree).err()
    }

    /// Hands in a player's range: each entry is card1 | (card2 << 8), card = 4 * rank + suit
    /// (rank 0 = deuce .. 12 = ace; suit 0 = clubs, 1 = diamonds, 2 = hearts, 3 = spades).
    pub fn private_cards(&self, player: usize) -> Box<[u16]> {
        self.game
            .private_cards(player)
            .iter()
            .map(|&(c1, c2)| c1 as u16 | ((c2 as u16) << 8))
            .collect()
    }

    /// Bytes of memory the solve needs, uncompressed or compressed (16-bit).
    pub fn memory_usage(&self, enable_compression: bool) -> f64 {
        let (a, b) = self.game.memory_usage();
        (if enable_compression { b } else { a }) as f64
    }

    pub fn allocate_memory(&mut self, enable_compression: bool) {
        self.game.allocate_memory(enable_compression);
    }

    pub fn solve_step(&self, current_iteration: u32) {
        let game = &self.game;
        in_pool(|| solve_step(game, current_iteration));
    }

    /// Exploitability in chips (same unit as the pot).
    pub fn exploitability(&self) -> f32 {
        let game = &self.game;
        in_pool(|| compute_exploitability(game))
    }

    pub fn finalize(&mut self) {
        let game = &mut self.game;
        in_pool(|| finalize(game));
    }

    /// Moves to a node: a list of action indexes, with a card id for each dealt turn/river card.
    pub fn apply_history(&mut self, history: &[u32]) {
        let h: Vec<usize> = history.iter().map(|&x| x as usize).collect();
        self.game.apply_history(&h);
    }

    pub fn total_bet_amount(&self) -> Box<[u32]> {
        self.game.total_bet_amount().iter().map(|&x| x as u32).collect()
    }

    /// "oop", "ip", "chance" (a card is dealt next) or "terminal".
    pub fn current_player(&self) -> String {
        if self.game.is_terminal_node() {
            "terminal".to_string()
        } else if self.game.is_chance_node() {
            "chance".to_string()
        } else if self.game.current_player() == 0 {
            "oop".to_string()
        } else {
            "ip".to_string()
        }
    }

    /// Actions at the current node, e.g. "Check:0/Bet:430/Allin:19000".
    pub fn actions(&self) -> String {
        if self.game.is_terminal_node() || self.game.is_chance_node() {
            return String::new();
        }
        self.game
            .available_actions()
            .iter()
            .map(|&x| match x {
                Action::Fold => "Fold:0".to_string(),
                Action::Check => "Check:0".to_string(),
                Action::Call => "Call:0".to_string(),
                Action::Bet(a) => format!("Bet:{a}"),
                Action::Raise(a) => format!("Raise:{a}"),
                Action::AllIn(a) => format!("Allin:{a}"),
                _ => "?:0".to_string(),
            })
            .collect::<Vec<_>>()
            .join("/")
    }

    /// At a chance node: bitmask of the cards that can come (bit n = card id n).
    pub fn possible_cards(&self) -> f64 {
        self.game.possible_cards() as f64
    }

    /// Everything the page shows for the current node, flattened:
    /// [pot_oop, pot_ip, empty_flag, weights0.., weights1.., normalizer0.., normalizer1..,
    ///  equity0.., equity1.., ev0.., ev1.., eqr0.., eqr1.., strategy.., action_ev..]
    /// (equity/ev/eqr only when neither range is empty; strategy and action_ev only at a
    /// player's node; action_ev only when neither range is empty).
    pub fn get_results(&mut self) -> Box<[f64]> {
        let game = &mut self.game;
        let mut buf = Vec::new();

        let total_bet_amount = game.total_bet_amount();
        let pot_base = game.tree_config().starting_pot + total_bet_amount.iter().min().unwrap();
        buf.push((pot_base + total_bet_amount[0]) as f64);
        buf.push((pot_base + total_bet_amount[1]) as f64);

        let trunc = |&w: &f32| if w < 0.0005 { 0.0 } else { w };
        let weights = [
            game.weights(0).iter().map(trunc).collect::<Vec<_>>(),
            game.weights(1).iter().map(trunc).collect::<Vec<_>>(),
        ];
        let is_empty = |player: usize| weights[player].iter().all(|&w| w == 0.0);
        let is_empty_flag = is_empty(0) as usize + 2 * is_empty(1) as usize;
        buf.push(is_empty_flag as f64);
        buf.extend(round_iter(weights[0].iter()));
        buf.extend(round_iter(weights[1].iter()));

        if is_empty_flag > 0 {
            buf.extend(round_iter(weights[0].iter()));
            buf.extend(round_iter(weights[1].iter()));
        } else {
            game.cache_normalized_weights();
            buf.extend(round_iter(game.normalized_weights(0).iter()));
            buf.extend(round_iter(game.normalized_weights(1).iter()));
            let equity = [game.equity(0), game.equity(1)];
            let ev = [game.expected_values(0), game.expected_values(1)];
            buf.extend(round_iter(equity[0].iter()));
            buf.extend(round_iter(equity[1].iter()));
            buf.extend(round_iter(ev[0].iter()));
            buf.extend(round_iter(ev[1].iter()));
            for player in 0..2 {
                let pot = (pot_base + total_bet_amount[player]) as f64;
                for (&eq, &ev) in equity[player].iter().zip(ev[player].iter()) {
                    let (eq, ev) = (eq as f64, ev as f64);
                    buf.push(if eq < 5e-7 { 0.0 } else { round(ev / (pot * eq)) });
                }
            }
        }

        if !game.is_terminal_node() && !game.is_chance_node() {
            buf.extend(round_iter(game.strategy().iter()));
            if is_empty_flag == 0 {
                buf.extend(round_iter(game.expected_values_detail(game.current_player()).iter()));
            }
        }
        buf.into_boxed_slice()
    }
}

impl Default for Solver {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(s: &str) -> u8 {
        card_from_str(s).unwrap()
    }

    #[test]
    fn solves_a_river_spot_and_reports_results() {
        let mut s = Solver::new();
        let board = [card("Qs"), card("Jh"), card("2h"), card("8d"), card("3c")];
        let err = s.init(
            "AA,KK,QQ,AQs,AQo,KQs,QJs,JTs,T9s,98s,87s,A5s:0.5",
            "AA,KK,QQ,JJ,TT,AKs,AKo,AQs,AQo,KQs,QJs,JTs:0.75",
            &board, 2000, 9000, 0.0, 0.0, "33%, 75%", "3x", "66%", "3x", "66%, 150%", "3x", 1.5, 0.15, 0.1,
        );
        assert_eq!(err, None, "init error");
        assert_eq!(s.current_player(), "oop");
        assert!(s.actions().starts_with("Check:0/Bet:"), "actions: {}", s.actions());
        let mem = s.memory_usage(false);
        assert!(mem > 0.0);
        s.allocate_memory(false);
        let mut expl = f32::MAX;
        for i in 0..400 {
            s.solve_step(i);
            if i % 50 == 49 {
                expl = s.exploitability();
                if expl < 2000.0 * 0.003 {
                    break;
                }
            }
        }
        assert!(expl < 2000.0 * 0.01, "exploitability too high: {expl}");
        s.finalize();
        s.apply_history(&[]);
        let r = s.get_results();
        let n0 = s.private_cards(0).len();
        let n1 = s.private_cards(1).len();
        let na = s.actions().split('/').count();
        // pots + flag + weights(2) + normalizer(2) + equity(2) + ev(2) + eqr(2) + strategy + action_ev
        assert_eq!(r.len(), 3 + 5 * (n0 + n1) + 2 * na * n0);
        // strategy for each hand sums to 1
        let strat = &r[3 + 5 * (n0 + n1)..3 + 5 * (n0 + n1) + na * n0];
        for h in 0..n0 {
            let sum: f64 = (0..na).map(|a| strat[a * n0 + h]).sum();
            assert!((sum - 1.0).abs() < 1e-3, "hand {h} sums to {sum}");
        }
        // navigate: check, then IP acts
        s.apply_history(&[0]);
        assert_eq!(s.current_player(), "ip");
    }

    #[test]
    fn flop_spot_has_chance_nodes_and_rejects_bad_input() {
        let mut s = Solver::new();
        let board = [card("Ks"), card("7d"), card("2c")];
        assert!(s
            .init("AA,KK", "QQ", &board, 1000, 10000, 0.0, 0.0, "50%", "3x", "50%", "3x", "50%", "3x", 1.5, 0.15, 0.1)
            .is_none());
        s.allocate_memory(true);
        for i in 0..20 {
            s.solve_step(i);
        }
        s.finalize();
        s.apply_history(&[0, 0]); // check, check -> turn card
        assert_eq!(s.current_player(), "chance");
        let mask = s.possible_cards() as u64;
        assert_eq!(mask & (1 << card("Ks")), 0, "board card cannot come again");
        assert!(mask.count_ones() > 40);
        // bad inputs come back as messages, not crashes
        assert!(s.init("ZZ", "QQ", &board, 1000, 10000, 0.0, 0.0, "50%", "3x", "50%", "3x", "50%", "3x", 1.5, 0.15, 0.1).is_some());
        assert!(s.init("AA", "QQ", &board[..2], 1000, 10000, 0.0, 0.0, "50%", "3x", "50%", "3x", "50%", "3x", 1.5, 0.15, 0.1).is_some());
        assert!(s.init("AA", "QQ", &board, 1000, 10000, 0.0, 0.0, "fifty", "3x", "50%", "3x", "50%", "3x", 1.5, 0.15, 0.1).is_some());
    }
}
