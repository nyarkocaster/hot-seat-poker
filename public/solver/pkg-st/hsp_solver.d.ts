/* tslint:disable */
/* eslint-disable */
export class Solver {
  free(): void;
  constructor();
  /**
   * Sets up a spot. Amounts are integers (the page uses cents). Bet sizes use the
   * postflop-solver syntax, e.g. "33%, 75%" for bets and "3x" for raises; "e" (geometric)
   * and "a" (all-in) are allowed too. Returns an error message, or None on success.
   */
  init(oop_range: string, ip_range: string, board: Uint8Array, starting_pot: number, effective_stack: number, rake_rate: number, rake_cap: number, flop_bet: string, flop_raise: string, turn_bet: string, turn_raise: string, river_bet: string, river_raise: string, add_allin_threshold: number, force_allin_threshold: number, merging_threshold: number): string | undefined;
  /**
   * Hands in a player's range: each entry is card1 | (card2 << 8), card = 4 * rank + suit
   * (rank 0 = deuce .. 12 = ace; suit 0 = clubs, 1 = diamonds, 2 = hearts, 3 = spades).
   */
  private_cards(player: number): Uint16Array;
  /**
   * Bytes of memory the solve needs, uncompressed or compressed (16-bit).
   */
  memory_usage(enable_compression: boolean): number;
  allocate_memory(enable_compression: boolean): void;
  solve_step(current_iteration: number): void;
  /**
   * Exploitability in chips (same unit as the pot).
   */
  exploitability(): number;
  finalize(): void;
  /**
   * Moves to a node: a list of action indexes, with a card id for each dealt turn/river card.
   */
  apply_history(history: Uint32Array): void;
  total_bet_amount(): Uint32Array;
  /**
   * "oop", "ip", "chance" (a card is dealt next) or "terminal".
   */
  current_player(): string;
  /**
   * Actions at the current node, e.g. "Check:0/Bet:430/Allin:19000".
   */
  actions(): string;
  /**
   * Node locking: fixes the strategy of the player acting at the node reached by `history`
   * (same format as apply_history). `strategy` is action-major (action * hands + hand) for that
   * player's hands; a hand whose values are all zero is left for the solver to choose.
   * `expected_actions` must match actions() at that node, so a lock made on an older tree
   * isn't put in the wrong place. Call after allocate_memory and before solve_step.
   * Returns "" when the lock is set, otherwise the reason it wasn't.
   */
  lock_at(history: Uint32Array, strategy: Float32Array, expected_actions: string): string;
  /**
   * At a chance node: bitmask of the cards that can come (bit n = card id n).
   */
  possible_cards(): number;
  /**
   * Everything the page shows for the current node, flattened:
   * [pot_oop, pot_ip, empty_flag, weights0.., weights1.., normalizer0.., normalizer1..,
   *  equity0.., equity1.., ev0.., ev1.., eqr0.., eqr1.., strategy.., action_ev..]
   * (equity/ev/eqr only when neither range is empty; strategy and action_ev only at a
   * player's node; action_ev only when neither range is empty).
   */
  get_results(): Float64Array;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_solver_free: (a: number, b: number) => void;
  readonly solver_new: () => number;
  readonly solver_init: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number, z: number) => [number, number];
  readonly solver_private_cards: (a: number, b: number) => [number, number];
  readonly solver_memory_usage: (a: number, b: number) => number;
  readonly solver_allocate_memory: (a: number, b: number) => void;
  readonly solver_solve_step: (a: number, b: number) => void;
  readonly solver_exploitability: (a: number) => number;
  readonly solver_finalize: (a: number) => void;
  readonly solver_apply_history: (a: number, b: number, c: number) => void;
  readonly solver_total_bet_amount: (a: number) => [number, number];
  readonly solver_current_player: (a: number) => [number, number];
  readonly solver_actions: (a: number) => [number, number];
  readonly solver_lock_at: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
  readonly solver_possible_cards: (a: number) => number;
  readonly solver_get_results: (a: number) => [number, number];
  readonly __wbindgen_export_0: WebAssembly.Table;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
