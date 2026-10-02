//! Tiny synthetic sfnt builder for font tests. We never check real font files into the repo
//! (licensing), so tests write these into a tempdir instead.

#![allow(dead_code)]

/// One `name` table record.
#[derive(Clone, Debug)]
pub struct NameRec {
    pub platform: u16,
    pub encoding: u16,
    pub language: u16,
    pub name_id: u16,
    pub value: String,
}

/// Windows platform, Unicode BMP encoding, given LCID (0x0409 = en-US, 0x0411 = ja-JP).
pub fn win(name_id: u16, language: u16, value: &str) -> NameRec {
    NameRec {
        platform: 3,
        encoding: 1,
        language,
        name_id,
        value: value.to_string(),
    }
}

/// Windows en-US record.
pub fn en(name_id: u16, value: &str) -> NameRec {
    win(name_id, 0x0409, value)
}

/// Macintosh platform, Roman encoding, English (language 0). ASCII values only.
pub fn mac_en(name_id: u16, value: &str) -> NameRec {
    assert!(value.is_ascii(), "mac_en fixture names must be ASCII");
    NameRec {
        platform: 1,
        encoding: 0,
        language: 0,
        name_id,
        value: value.to_string(),
    }
}

pub const TRUETYPE: [u8; 4] = [0, 1, 0, 0];
pub const OPENTYPE_CFF: [u8; 4] = *b"OTTO";
pub const APPLE_TRUE: [u8; 4] = *b"true";

fn name_table(names: &[NameRec]) -> Vec<u8> {
    let mut strings = Vec::new();
    let mut records = Vec::new();
    for n in names {
        let bytes: Vec<u8> = if n.platform == 1 {
            n.value.as_bytes().to_vec()
        } else {
            n.value
                .encode_utf16()
                .flat_map(|u| u.to_be_bytes())
                .collect()
        };
        for v in [n.platform, n.encoding, n.language, n.name_id] {
            records.extend_from_slice(&v.to_be_bytes());
        }
        records.extend_from_slice(&(bytes.len() as u16).to_be_bytes());
        records.extend_from_slice(&(strings.len() as u16).to_be_bytes());
        strings.extend_from_slice(&bytes);
    }
    let mut t = Vec::new();
    t.extend_from_slice(&0u16.to_be_bytes()); // format 0
    t.extend_from_slice(&(names.len() as u16).to_be_bytes());
    t.extend_from_slice(&((6 + records.len()) as u16).to_be_bytes());
    t.extend_from_slice(&records);
    t.extend_from_slice(&strings);
    t
}

fn head_table() -> Vec<u8> {
    let mut t = vec![0u8; 54];
    t[0..4].copy_from_slice(&0x0001_0000u32.to_be_bytes()); // version
    t[12..16].copy_from_slice(&0x5F0F_3CF5u32.to_be_bytes()); // magic
    t[18..20].copy_from_slice(&1000u16.to_be_bytes()); // unitsPerEm
    t
}

fn hhea_table() -> Vec<u8> {
    let mut t = vec![0u8; 36];
    t[0..4].copy_from_slice(&0x0001_0000u32.to_be_bytes());
    t[34..36].copy_from_slice(&1u16.to_be_bytes()); // numberOfHMetrics
    t
}

fn maxp_table() -> Vec<u8> {
    let mut t = Vec::new();
    t.extend_from_slice(&0x0000_5000u32.to_be_bytes()); // version 0.5
    t.extend_from_slice(&1u16.to_be_bytes()); // numGlyphs
    t
}

/// An `fvar` table with one `wght` axis and one named instance per subfamily name ID.
fn fvar_table(instance_name_ids: &[u16]) -> Vec<u8> {
    let mut t = Vec::new();
    for v in [1u16, 0, 16, 2, 1, 20, instance_name_ids.len() as u16, 8] {
        // version 1.0, axesArrayOffset, reserved, axisCount, axisSize, instanceCount, instanceSize
        t.extend_from_slice(&v.to_be_bytes());
    }
    t.extend_from_slice(b"wght");
    for fixed in [100u32 << 16, 400 << 16, 900 << 16] {
        t.extend_from_slice(&fixed.to_be_bytes()); // min, default, max
    }
    t.extend_from_slice(&[0, 0, 1, 0]); // flags, axisNameID 256
    for (i, id) in instance_name_ids.iter().enumerate() {
        t.extend_from_slice(&id.to_be_bytes());
        t.extend_from_slice(&0u16.to_be_bytes());
        t.extend_from_slice(&((100 + 100 * i as u32) << 16).to_be_bytes());
    }
    t
}

/// Build one face whose table offsets are relative to a file in which this face starts at `base`.
fn build_face_at(magic: [u8; 4], names: &[NameRec], base: u32) -> Vec<u8> {
    build_face_with(magic, names, None, base)
}

fn build_face_with(magic: [u8; 4], names: &[NameRec], fvar: Option<Vec<u8>>, base: u32) -> Vec<u8> {
    let mut tables: Vec<([u8; 4], Vec<u8>)> = vec![
        (*b"head", head_table()),
        (*b"hhea", hhea_table()),
        (*b"maxp", maxp_table()),
        (*b"name", name_table(names)),
    ];
    tables.extend(fvar.map(|t| (*b"fvar", t)));
    // Table records must be sorted by tag (readers binary-search them).
    tables.sort_by_key(|(tag, _)| *tag);
    let n = tables.len() as u16;
    let mut out = Vec::new();
    out.extend_from_slice(&magic);
    out.extend_from_slice(&n.to_be_bytes());
    out.extend_from_slice(&[0, 0, 0, 0, 0, 0]); // searchRange, entrySelector, rangeShift
    let dir_len = 12 + 16 * tables.len();
    let mut offset = dir_len;
    let mut body = Vec::new();
    for (tag, data) in &tables {
        out.extend_from_slice(tag);
        out.extend_from_slice(&0u32.to_be_bytes()); // checksum (not verified)
        out.extend_from_slice(&(base + offset as u32).to_be_bytes());
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let mut padded = data.clone();
        while padded.len() % 4 != 0 {
            padded.push(0);
        }
        offset += padded.len();
        body.extend_from_slice(&padded);
    }
    out.extend_from_slice(&body);
    out
}

/// A TrueType variable font: `names` plus an `fvar` whose named instances use these name IDs.
pub fn build_variable_font(names: &[NameRec], instance_name_ids: &[u16]) -> Vec<u8> {
    build_face_with(TRUETYPE, names, Some(fvar_table(instance_name_ids)), 0)
}

/// A single-face font file with the given sfnt magic.
pub fn build_font(magic: [u8; 4], names: &[NameRec]) -> Vec<u8> {
    build_face_at(magic, names, 0)
}

/// A `ttcf` collection with one face per entry.
pub fn build_collection(faces: &[Vec<NameRec>]) -> Vec<u8> {
    let header_len = 12 + 4 * faces.len();
    let mut out = Vec::new();
    out.extend_from_slice(b"ttcf");
    out.extend_from_slice(&0x0001_0000u32.to_be_bytes());
    out.extend_from_slice(&(faces.len() as u32).to_be_bytes());
    let mut bodies = Vec::new();
    let mut base = header_len;
    for names in faces {
        let face = build_face_at(TRUETYPE, names, base as u32);
        out.extend_from_slice(&(base as u32).to_be_bytes());
        base += face.len();
        bodies.push(face);
    }
    for b in bodies {
        out.extend_from_slice(&b);
    }
    out
}
