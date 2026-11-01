use lupino_core::{import, Store};
use std::io::{Cursor, Write};

#[test]
fn docx_schedule_keeps_date_and_exam_in_the_same_evidence() {
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    archive
        .start_file(
            "word/document.xml",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
    archive
        .write_all(
            br#"<w:document xmlns:w="urn:word"><w:body>
      <w:p><w:r><w:t>Cronograma de Algebra</w:t></w:r></w:p>
      <w:tbl><w:tr>
        <w:tc><w:p><w:r><w:t>12/11/2026</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Segundo parcial</w:t></w:r></w:p>
          <w:p><w:r><w:t>a las 08:30</w:t></w:r></w:p></w:tc>
      </w:tr></w:tbl>
      <w:p><w:r><w:t>Consultar cambios en Teams.</w:t></w:r></w:p>
    </w:body></w:document>"#,
        )
        .unwrap();
    let bytes = archive.finish().unwrap().into_inner();
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let id = import::import_bytes(&store, "cronograma.docx", &bytes, "Algebra", None).unwrap();
    let source = store.source(&id).unwrap();
    assert_eq!(source.chunks.len(), 3);
    let events = store.events().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].date, "2026-11-12");
    assert_eq!(events[0].time.as_deref(), Some("08:30"));
    assert!(events[0].evidence.contains("Segundo parcial"));
    assert!(events[0].evidence.contains("12/11/2026"));
    assert!(source.chunks.iter().any(|c| c.text == events[0].evidence));
}
