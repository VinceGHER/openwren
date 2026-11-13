//! Synthetic mail for benchmarks. The app itself never calls this.
//!
//! The mail is generated from a fixed seed, so every run and every machine
//! gets the same mailbox: same senders, subjects, dates and text.

use rusqlite::{params, Connection};

use crate::db::{self, NewMessage};
use crate::error::Result;
use crate::parse::Header;

/// A small, fast random generator with a fixed seed (xorshift), so results repeat.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng(seed.max(1))
    }
    pub fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    pub fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

const SYLLABLES: &[&str] = &["ka", "to", "mi", "ren", "sol", "vex", "pla", "du", "ne", "bri", "han", "os", "tel", "ur", "gim", "pax", "lo", "sef", "cor", "wyn"];
const FIRST: &[&str] = &["Mona", "Elvia", "Kadji", "Laurence", "Cameron", "Amanda", "Soren", "Priya", "Tomas", "Ines", "Yuki", "Omar", "Greta", "Luca", "Nadia", "Felix"];
const LAST: &[&str] = &["Kane", "Atkins", "Bell", "Gilbertson", "Evans", "Brady", "Ostergard", "Raman", "Novak", "Duarte", "Sato", "Haddad", "Lind", "Moretti", "Petrov", "Baum"];
const TOPICS: &[&str] = &["Invoice", "Meeting notes", "Project update", "Quarterly report", "Travel plans", "Contract draft", "Design review", "Release schedule", "Budget", "Hiring", "Support ticket", "Newsletter"];

/// A vocabulary of made-up words. Word 0 is the most common, the last ones are rare,
/// which gives search both frequent and rare terms to look for.
pub fn vocabulary() -> Vec<String> {
    let mut words = Vec::new();
    for a in SYLLABLES {
        for b in SYLLABLES {
            for c in ["", "n", "s", "ra", "lo"] {
                words.push(format!("{a}{b}{c}"));
            }
        }
    }
    words
}

/// Fill a folder with `count` messages spread over about six years, newest first by id.
/// `now` is the date of the newest message (Unix seconds).
pub fn fill(conn: &mut Connection, account_id: i64, folder_id: i64, count: usize, now: i64) -> Result<()> {
    let words = vocabulary();
    let mut rng = Rng::new(0x5EED_CAFE);
    let span = 6 * 365 * 86_400i64;
    for batch in (0..count).collect::<Vec<_>>().chunks(10_000) {
        let tx = conn.transaction()?;
        for &i in batch {
            let (first, last) = (FIRST[rng.below(FIRST.len())], LAST[rng.below(LAST.len())]);
            let company = &words[rng.below(60)];
            let bulk = rng.below(10) < 3;
            // Common words are picked far more often than rare ones.
            let pick = |rng: &mut Rng| {
                let r = rng.below(1000);
                let index = if r < 600 { rng.below(40) } else if r < 950 { rng.below(400) } else { rng.below(words.len()) };
                words[index].clone()
            };
            let subject = format!("{} {} {}", TOPICS[rng.below(TOPICS.len())], pick(&mut rng), i);
            let body: Vec<String> = (0..120).map(|_| pick(&mut rng)).collect();
            let plain = body.join(" ");
            let header = Header {
                from_name: format!("{first} {last}"),
                from_address: format!("{}.{}@{company}.example", first.to_lowercase(), last.to_lowercase()),
                to_list: "Katy Reid".into(),
                to_addresses: "Katy Reid <katy@work.test>".into(),
                subject,
                date: Some(now - (i as i64 * span / count.max(1) as i64)),
                message_id: Some(format!("bench-{i}@openwren.test")),
                focused: !bulk,
                ..Header::default()
            };
            let id = db::insert_message(
                &tx,
                &NewMessage { account_id, folder_id, uid: Some(i as u32 + 1), header: &header, fallback_date: now, size: plain.len() as u32, unread: rng.below(10) < 2, flagged: rng.below(50) == 0 },
            )?;
            tx.execute("INSERT INTO bodies (message_id, html, plain) VALUES (?1, NULL, ?2)", params![id, plain])?;
            tx.execute("UPDATE messages SET preview = ?2 WHERE id = ?1", params![id, body[..20].join(" ")])?;
            tx.execute("UPDATE search_index SET body = ?2 WHERE rowid = ?1", params![id, plain])?;
        }
        tx.commit()?;
    }
    Ok(())
}
