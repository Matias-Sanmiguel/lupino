use lupino_core::{import, native};
use std::io::Cursor;

#[test]
fn remote_files_update_one_source_and_keep_previous_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let store = lupino_core::Store::open(dir.path()).unwrap();
    let mut remote = import::RemoteFile {
        id: "12345678-1234-4234-8234-123456789abc".into(),
        path: "Materiales de clase/Unidad 1/guía.txt".into(),
        modified_at: "2026-11-01T12:00:00Z".into(),
    };
    let origin = "https://facu.sharepoint.com/sites/algebra/Documentos/gu%C3%ADa.txt";
    let first = import::import_remote_bytes(
        &store,
        "guía.txt",
        b"Matrices originales",
        "Algebra",
        origin,
        &remote,
    )
    .unwrap();
    let evidence = store.search("originales", None).unwrap()[0].clone();
    assert_eq!(
        first,
        import::import_remote_bytes(
            &store,
            "guía.txt",
            b"Matrices originales",
            "Algebra",
            origin,
            &remote
        )
        .unwrap()
    );
    remote.path = "Materiales de clase/Unidad 2/repaso.txt".into();
    let next_origin = "https://facu.sharepoint.com/sites/algebra/Documentos/repaso.txt";
    assert_eq!(
        first,
        import::import_remote_bytes(
            &store,
            "repaso.txt",
            b"Determinantes actualizados",
            "Algebra",
            next_origin,
            &remote
        )
        .unwrap()
    );
    assert_eq!(store.sources().unwrap().len(), 1);
    assert!(store.search("originales", None).unwrap().is_empty());
    assert!(store
        .read_chunk(&evidence.id)
        .unwrap()
        .text
        .contains("originales"));
    let current = store.source(&first).unwrap();
    assert_eq!(current.source.title, remote.path);
    assert_eq!(current.source.origin_url.as_deref(), Some(next_origin));
    remote.path = "Materiales de clase/Unidad 3/repaso.txt".into();
    import::import_remote_bytes(
        &store,
        "repaso.txt",
        b"Determinantes actualizados",
        "Algebra",
        next_origin,
        &remote,
    )
    .unwrap();
    assert_eq!(store.source(&first).unwrap().source.title, remote.path);
}

#[test]
fn out_of_order_remote_inbox_never_replaces_a_newer_document() {
    use base64::Engine;
    let dir = tempfile::tempdir().unwrap();
    let store = lupino_core::Store::open(dir.path()).unwrap();
    let inbox = dir.path().join("inbox");
    std::fs::create_dir_all(&inbox).unwrap();
    let payload = |text: &str, modified: &str| serde_json::json!({"type":"file","name":"guia.txt","subject":"Algebra","originUrl":"https://facu.sharepoint.com/sites/class/guia.txt","remote":{"id":"12345678-1234-4234-8234-123456789abc","path":"Materiales/guia.txt","modifiedAt":modified},"data":base64::engine::general_purpose::STANDARD.encode(text)});
    // Deliver each batch deliberately in reverse server-version order.
    std::fs::write(
        inbox.join("new.json"),
        serde_json::to_vec(&payload("Determinantes nuevos", "2026-11-02T12:00:00Z")).unwrap(),
    )
    .unwrap();
    assert_eq!(native::process_inbox(&store).unwrap().1.len(), 0);
    let current = store.search("nuevos", None).unwrap()[0].clone();
    std::fs::write(
        inbox.join("old.json"),
        serde_json::to_vec(&payload("Matrices antiguas", "2026-11-01T12:00:00Z")).unwrap(),
    )
    .unwrap();
    assert_eq!(native::process_inbox(&store).unwrap().1.len(), 0);
    assert_eq!(store.sources().unwrap().len(), 1);
    assert!(store.search("antiguas", None).unwrap().is_empty());
    assert_eq!(store.search("nuevos", None).unwrap()[0].id, current.id);
    assert!(store
        .read_chunk(&current.id)
        .unwrap()
        .text
        .contains("nuevos"));
}

#[test]
fn remote_file_transport_rejects_invalid_identity_and_scope() {
    let valid = serde_json::json!({"type":"file","name":"guía.txt","subject":"Algebra","data":"aG9sYQ==","originUrl":"https://facu.sharepoint.com/sites/algebra/guia.txt","remote":{"id":"12345678-1234-4234-8234-123456789abc","path":"Materiales/guía.txt","modifiedAt":"2026-11-01T12:00:00Z"}});
    assert!(native::validate_payload(&valid).is_ok());
    for origin in [
        "https://facu.sharepoint.com.evil.test/guia.txt",
        "http://facu.sharepoint.com/guia.txt",
        "https://user@facu.sharepoint.com/guia.txt",
    ] {
        let mut v = valid.clone();
        v["originUrl"] = origin.into();
        assert!(native::validate_payload(&v).is_err());
    }
    for path in [
        "../guía.txt",
        "/Materiales/guía.txt",
        "Materiales/../guía.txt",
        "Materiales/otro.txt",
    ] {
        let mut v = valid.clone();
        v["remote"]["path"] = path.into();
        assert!(native::validate_payload(&v).is_err());
    }
    let mut v = valid.clone();
    v["remote"]["id"] = "fake".into();
    assert!(native::validate_payload(&v).is_err());
    v = valid;
    v["remote"] = serde_json::Value::Null;
    assert!(native::validate_payload(&v).is_err());
}

#[test]
fn native_framing_handles_round_trip_and_rejects_oversized_frames() {
    let mut bytes = Vec::new();
    native::write_frame(&mut bytes, &serde_json::json!({"ok": true})).unwrap();
    assert_eq!(
        native::read_frame(&mut Cursor::new(bytes))
            .unwrap()
            .unwrap()["ok"],
        true
    );
    assert!(native::read_frame(&mut Cursor::new((native::MAX_FRAME + 1).to_ne_bytes())).is_err());
    assert!(native::read_frame(&mut Cursor::new(vec![4, 0])).is_err());
}

#[test]
fn text_import_preserves_spanish_and_rejects_unsafe_names() {
    let parsed = import::parse_bytes("guía.md", "Álgebra: matrices y vectores".as_bytes()).unwrap();
    assert_eq!(parsed[0].1, "Álgebra: matrices y vectores");
    assert!(import::validate_name("../secreto.md").is_err());
    assert!(import::validate_name("C:\\tmp\\secreto.md").is_err());
    assert!(import::parse_bytes("macro.exe", b"anything").is_err());
}

#[test]
fn office_import_preserves_paragraphs_and_slide_order() {
    use std::io::Write;
    fn office(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, xml) in entries {
            zip.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(xml.as_bytes()).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }
    let docx = office(&[(
        "word/document.xml",
        r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Matrices y </w:t></w:r><w:r><w:t>determinantes</w:t></w:r></w:p><w:p><w:r><w:t>Entrega el 12/11/2026</w:t></w:r></w:p></w:body></w:document>"#,
    )]);
    let doc = import::parse_bytes("guía.docx", &docx).unwrap();
    assert_eq!(doc.len(), 2);
    assert_eq!(
        doc[0],
        ("Párrafo 1".into(), "Matrices y determinantes".into())
    );
    let xml = r#"<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:r><a:t>Álgebra</a:t></a:r></a:p></p:sld>"#;
    let pptx = office(&[
        ("ppt/slides/slide10.xml", xml),
        ("ppt/slides/slide2.xml", xml),
    ]);
    let slides = import::parse_bytes("clase.pptx", &pptx).unwrap();
    assert_eq!(slides[0].0, "Diapositiva 2");
    assert_eq!(slides[1].0, "Diapositiva 10");
    assert_eq!(slides[0].1, "Álgebra");
    assert!(import::parse_bytes("roto.docx", b"not a zip").is_err());
}

#[test]
fn pdf_import_reports_real_page_numbers_and_keeps_scans_unread() {
    lupino_core::pdf_worker::configure(std::path::PathBuf::from(env!(
        "CARGO_BIN_EXE_lupino-document-worker"
    )));
    fn pdf(text: &str) -> Vec<u8> {
        let stream = format!("BT /F1 12 Tf 50 750 Td ({text}) Tj ET");
        let objects=vec!["<< /Type /Catalog /Pages 2 0 R >>".to_string(),"<< /Type /Pages /Count 2 /Kids [3 0 R 5 0 R] >>".into(),"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>".into(),format!("<< /Length {} >>\nstream\n{stream}\nendstream",stream.len()),"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>".into(),"<< /Length 0 >>\nstream\n\nendstream".into(),"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".into()];
        let mut result = "%PDF-1.4\n".to_string();
        let mut offsets = vec![0];
        for (i, obj) in objects.iter().enumerate() {
            offsets.push(result.len());
            result += &format!("{} 0 obj\n{obj}\nendobj\n", i + 1);
        }
        let start = result.len();
        result += &format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1);
        for offset in offsets.iter().skip(1) {
            result += &format!("{offset:010} 00000 n \n");
        }
        result += &format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n",
            objects.len() + 1
        );
        result.into_bytes()
    }
    let pages = import::parse_bytes("clase.pdf", &pdf("Matrices y vectores")).unwrap();
    assert_eq!(pages.len(), 2);
    assert_eq!(pages[0].0, "Página 1");
    assert!(pages[0].1.contains("Matrices y vectores"));
    assert_eq!(pages[1].0, "Página 2");
    let dir = tempfile::tempdir().unwrap();
    let store = lupino_core::Store::open(dir.path()).unwrap();
    let id = import::import_bytes(&store, "escaneo.pdf", &pdf(""), "Álgebra", None).unwrap();
    assert_eq!(store.source(&id).unwrap().source.status, "needs_ocr");
}

#[test]
fn compressed_pdf_expansion_is_bounded_in_a_worker() {
    use std::io::Write;
    let text = "A".repeat(10 * 1024 * 1024);
    let stream = format!("BT /F1 12 Tf 50 750 Td ({text}) Tj ET");
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(stream.as_bytes()).unwrap();
    let compressed = encoder.finish().unwrap();
    let mut bytes = b"%PDF-1.4\n".to_vec();
    let mut offsets = vec![0];
    let objects=vec![b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),b"<< /Type /Pages /Count 1 /Kids [3 0 R] >>".to_vec(),b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>".to_vec(),[format!("<< /Length {} /Filter /FlateDecode >>\nstream\n",compressed.len()).as_bytes(),&compressed,b"\nendstream"].concat(),b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_vec()];
    for (i, object) in objects.iter().enumerate() {
        offsets.push(bytes.len());
        bytes.extend_from_slice(format!("{} 0 obj\n", i + 1).as_bytes());
        bytes.extend(object);
        bytes.extend(b"\nendobj\n");
    }
    let xref = bytes.len();
    bytes.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
    for offset in offsets.iter().skip(1) {
        bytes.extend(format!("{offset:010} 00000 n \n").as_bytes());
    }
    bytes.extend(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            objects.len() + 1
        )
        .as_bytes(),
    );
    assert!(bytes.len() < 100_000);
    lupino_core::pdf_worker::configure(std::path::PathBuf::from(env!(
        "CARGO_BIN_EXE_lupino-document-worker"
    )));
    let start = std::time::Instant::now();
    assert!(import::parse_bytes("expansion.pdf", &bytes).is_err());
    assert!(start.elapsed() < std::time::Duration::from_secs(25));
}
