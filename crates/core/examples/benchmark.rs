use lupino_core::{NewSource, Store};
use std::time::Instant;
fn main() -> anyhow::Result<()> {
    let dir = tempfile::tempdir()?;
    let store = Store::open(dir.path())?;
    let start = Instant::now();
    for doc in 0..100 {
        let sections = (0..200)
            .map(|n| {
                (
                    format!("Sección {n}"),
                    format!(
                        "Tema matrices documento {doc} sección {n}. {}",
                        "Apunte de álgebra sobre vectores y espacios lineales. ".repeat(30)
                    ),
                )
            })
            .collect();
        store.ingest_source(NewSource {
            key: format!("benchmark:{doc}"),
            title: format!("Apunte {doc}"),
            subject: format!("Materia {}", doc % 10),
            kind: "txt".into(),
            origin_url: None,
            author: None,
            published_at: None,
            attachments: vec![],
            sections,
            status: "ready".into(),
        })?;
    }
    let indexing = start.elapsed();
    let mut times = Vec::new();
    for i in 0..100 {
        let start = Instant::now();
        let results = store.search("matrices espacios", Some(&format!("Materia {}", i % 10)))?;
        assert_eq!(results.len(), 12);
        times.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    times.sort_by(f64::total_cmp);
    println!("20,000 fragments, 100 sources. Index: {:.2}s. Search p50: {:.2}ms, p95: {:.2}ms (100 scoped searches).",indexing.as_secs_f64(),times[49],times[94]);
    Ok(())
}
