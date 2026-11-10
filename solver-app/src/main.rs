// Hot Seat Solver: a small program that runs postflop solves for hotseatpoker.com on this computer.
// The web page connects to it at ws://127.0.0.1:47123 and sends the same messages it would send
// to the in-browser solver (setup, solve, stop, node). Nothing leaves this computer, and only the
// Hot Seat Poker website may connect.
//
// Copyright (C) Hot Seat Poker contributors. Licensed under the GNU AGPL v3 or later (see LICENSE).
// Solver engine: postflop-solver by Wataru Inariba (AGPL-3.0-or-later).

use hsp_solver::Solver;
use serde_json::{json, Value};
use std::io::ErrorKind;
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::{accept_hdr, Message};

const PORT: u16 = 47123;
const VERSION: &str = env!("CARGO_PKG_VERSION");
const ORIGINS: &[&str] = &[
    "https://hotseatpoker.com",
    "https://www.hotseatpoker.com",
    "https://hot-seat-poker.christophersahrens.workers.dev",
    "http://localhost:8787",
    "http://127.0.0.1:8787",
];

struct State {
    solver: Mutex<Option<Solver>>,
    stop: AtomicBool,
    threads: usize,
    ram: u64,
}

fn gb(b: f64) -> String {
    if b < 1e9 { format!("{:.0} MB", b / 1e6) } else { format!("{:.1} GB", b / 1e9) }
}

fn pause() {
    println!("\nPress Enter to close this window.");
    let mut s = String::new();
    let _ = std::io::stdin().read_line(&mut s);
}

fn main() {
    let ram = {
        let mut s = sysinfo::System::new();
        s.refresh_memory();
        s.total_memory()
    };
    let threads = thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let listener = match TcpListener::bind(("127.0.0.1", PORT)) {
        Ok(l) => l,
        Err(e) => {
            println!("Hot Seat Solver couldn't start: something else is using port {PORT}.");
            println!("It may already be open in another window. ({e})");
            pause();
            return;
        }
    };
    println!("Hot Seat Solver {VERSION} is running.");
    println!("Leave this window open while you use the solver on hotseatpoker.com, then press");
    println!("\"Connect the solver app\" on the solver. Close this window to stop it.");
    println!("This computer: {threads} CPU threads, {} of memory.\n", gb(ram as f64));
    let st = Arc::new(State { solver: Mutex::new(None), stop: AtomicBool::new(false), threads, ram });
    for stream in listener.incoming().flatten() {
        let st = st.clone();
        thread::spawn(move || handle(stream, st));
    }
}

fn handle(stream: TcpStream, st: Arc<State>) {
    let check = |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
        let origin = req.headers().get("origin").and_then(|o| o.to_str().ok()).unwrap_or("");
        if ORIGINS.contains(&origin) {
            Ok(resp)
        } else {
            let mut r = ErrorResponse::new(Some("Only hotseatpoker.com may use this solver.".into()));
            *r.status_mut() = tungstenite::http::StatusCode::FORBIDDEN;
            Err(r)
        }
    };
    let mut ws = match accept_hdr(stream, check) {
        Ok(ws) => ws,
        Err(_) => return,
    };
    let _ = ws.get_mut().set_read_timeout(Some(Duration::from_millis(40)));
    println!("A Hot Seat Poker page connected.");
    let (tx, rx) = channel::<String>();
    loop {
        while let Ok(m) = rx.try_recv() {
            if ws.send(Message::text(m)).is_err() {
                return;
            }
        }
        match ws.read() {
            Ok(Message::Text(t)) => on_message(&t, &st, &tx),
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(_) => break,
        }
    }
    println!("The page disconnected.");
}

fn s(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap_or("").to_string()
}
fn f(v: &Value, k: &str) -> f64 {
    v[k].as_f64().unwrap_or(0.0)
}

fn on_message(text: &str, st: &Arc<State>, tx: &Sender<String>) {
    let m: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return,
    };
    let t = m["t"].as_str().unwrap_or("");
    let send = |v: Value| {
        let _ = tx.send(v.to_string());
    };
    match t {
        "load" | "hello" => send(json!({"t":"loaded","threads":st.threads,"ram":st.ram,"version":VERSION,"app":true})),
        "stop" => st.stop.store(true, Ordering::SeqCst),
        "setup" => {
            let sp = &m["spot"];
            let board: Vec<u8> = sp["board"].as_array().map(|a| a.iter().filter_map(|x| x.as_u64()).map(|x| x as u8).collect()).unwrap_or_default();
            let mut guard = match st.solver.try_lock() {
                Ok(g) => g,
                Err(_) => return send(json!({"t":"error","during":"setup","msg":"The solver app is busy with another solve."})),
            };
            *guard = None; // free the old game before building a new one
            let mut solver = Solver::new();
            let err = solver.init(
                &s(sp, "oop"), &s(sp, "ip"), &board, f(sp, "pot") as i32, f(sp, "eff") as i32, f(sp, "rake"), f(sp, "rakeCap"),
                &s(sp, "fb"), &s(sp, "fr"), &s(sp, "tb"), &s(sp, "tr"), &s(sp, "rb"), &s(sp, "rr"),
                f(sp, "allinT"), f(sp, "forceT"), 0.1,
            );
            if let Some(e) = err {
                return send(json!({"t":"setup","err":e}));
            }
            let mem = [solver.memory_usage(false), solver.memory_usage(true)];
            let cards = [solver.private_cards(0).to_vec(), solver.private_cards(1).to_vec()];
            *guard = Some(solver);
            send(json!({"t":"setup","mem":mem,"cards":cards,"ram":st.ram}));
        }
        "solve" => {
            let compress = m["compress"].as_bool().unwrap_or(false);
            let target = f(&m, "target") as f32;
            let max_iter = (m["maxIter"].as_u64().unwrap_or(1000) as u32).clamp(1, 100000);
            let locks = m["locks"].clone();
            let st2 = st.clone();
            let tx2 = tx.clone();
            st.stop.store(false, Ordering::SeqCst);
            thread::spawn(move || {
                let send = |v: Value| {
                    let _ = tx2.send(v.to_string());
                };
                let mut guard = match st2.solver.lock() {
                    Ok(g) => g,
                    Err(_) => return send(json!({"t":"error","during":"solve","msg":"The solver app hit an error. Close it and open it again."})),
                };
                let solver = match guard.as_mut() {
                    Some(sv) => sv,
                    None => return send(json!({"t":"error","during":"solve","msg":"Set up the spot first."})),
                };
                let need = solver.memory_usage(compress);
                if need > st2.ram as f64 * 0.85 {
                    return send(json!({"t":"error","during":"solve","msg":format!("This tree needs about {} but this computer has {} of memory. Use fewer bet sizes or narrower ranges.", gb(need), gb(st2.ram as f64))}));
                }
                println!("Solving (about {} of memory)…", gb(need));
                let t0 = Instant::now();
                solver.allocate_memory(compress);
                // node locks: [{hist:[..], s:[..], acts:".."}]; report each one ("" = set)
                if let Some(locks) = locks.as_array() {
                    let res: Vec<String> = locks.iter().map(|l| {
                        let hist: Vec<u32> = l["hist"].as_array().map(|a| a.iter().filter_map(|x| x.as_u64()).map(|x| x as u32).collect()).unwrap_or_default();
                        let strat: Vec<f32> = l["s"].as_array().map(|a| a.iter().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect()).unwrap_or_default();
                        solver.lock_at(&hist, &strat, l["acts"].as_str().unwrap_or(""))
                    }).collect();
                    if !res.is_empty() { send(json!({"t":"locks","res":res})); }
                }
                send(json!({"t":"progress","i":0,"e":null}));
                let (mut i, mut e) = (0u32, f32::INFINITY);
                let mut stopped = false;
                while i < max_iter {
                    solver.solve_step(i);
                    i += 1;
                    if i % 10 == 0 || i == max_iter {
                        e = solver.exploitability();
                        send(json!({"t":"progress","i":i,"e":e}));
                        if e <= target {
                            break;
                        }
                    }
                    if st2.stop.load(Ordering::SeqCst) {
                        stopped = true;
                        e = solver.exploitability();
                        break;
                    }
                }
                solver.finalize();
                println!("Done: {i} iterations in {:.1} s.", t0.elapsed().as_secs_f64());
                send(json!({"t":"solved","i":i,"e":e,"stopped":stopped}));
            });
        }
        "node" => {
            let hist: Vec<u32> = m["hist"].as_array().map(|a| a.iter().filter_map(|x| x.as_u64()).map(|x| x as u32).collect()).unwrap_or_default();
            let mut guard = match st.solver.try_lock() {
                Ok(g) => g,
                Err(_) => return send(json!({"t":"error","during":"node","msg":"The solver app is still solving."})),
            };
            let solver = match guard.as_mut() {
                Some(sv) => sv,
                None => return send(json!({"t":"error","during":"node","msg":"Nothing has been solved yet."})),
            };
            solver.apply_history(&hist);
            let p = solver.current_player();
            let possible = if p == "chance" { solver.possible_cards() } else { 0.0 };
            let res = solver.get_results();
            send(json!({"t":"node","hist":hist,"p":p,"acts":solver.actions(),"tb":solver.total_bet_amount().to_vec(),"possible":possible,"res":res.to_vec()}));
        }
        _ => {}
    }
}
