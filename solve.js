// A fast drop-in for csv-reader 1.0.0: run(input) returns exactly csv-reader's
// {columns, rows, errors} for every input, but reads the text with slice-based
// field extraction instead of character-at-a-time concatenation.
//
// Semantics (identical to the reference, including every broken-row rule):
//   - a U+FEFF at the very start is dropped;
//   - a record ends at LF or CRLF; a line with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next undoubled quote; "" is
//     one quote; CRLF or a lone CR inside quotes reads as LF; text after the
//     closing quote up to the next comma or line break is appended as it
//     stands (quote_junk when anything was appended); a quote that never
//     closes is a literal character and the rest is re-read unquoted
//     (unterminated_quote);
//   - a quote inside an unquoted field is literal; fields stay strings;
//   - columns is the first record when header is true, else null; rows are
//     padded ("") or cut to the first record's width (short_row / long_row);
//   - each error is {code, line, row}: line the 1-based line the record
//     starts on, row its index in rows (null for the header), in the order
//     met, a record's short_row or long_row when the record ends.

const COMMA_END = 0;
const BREAK_END = 1;
const TEXT_END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0;
  let line = 1;
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  let recordLine = 1;
  let recordRow = null;

  // The field just read: its value, how it ended, and how many characters an
  // unquoted read kept (watched for quote_junk after a quoted field).
  let fval = '';
  let fend = TEXT_END;
  let fadded = 0;

  // Reads unquoted characters from pos up to the next comma or line break.
  // prefix is null, or an array of string parts the value already holds
  // (a quoted field's value on the quote_junk path, or ['"'] when an
  // unterminated quote is re-read as unquoted). Sets fval/fend/fadded.
  function readUnquoted(prefix) {
    let parts = prefix;
    let seg = pos; // start of the stretch not yet sliced into parts
    let added = 0; // characters this call kept (the prefix not counted)
    while (pos < n) {
      const code = text.charCodeAt(pos);
      if (code === 44) {
        // ','
        added += pos - seg;
        fval = parts === null ? text.slice(seg, pos) : (parts.push(text.slice(seg, pos)), parts.join(''));
        pos += 1;
        fend = COMMA_END;
        fadded = added;
        return;
      }
      if (code === 10) {
        // '\n'
        added += pos - seg;
        fval = parts === null ? text.slice(seg, pos) : (parts.push(text.slice(seg, pos)), parts.join(''));
        pos += 1;
        line += 1;
        fend = BREAK_END;
        fadded = added;
        return;
      }
      if (code === 13) {
        // '\r'
        if (text.charCodeAt(pos + 1) === 10) {
          added += pos - seg;
          fval = parts === null ? text.slice(seg, pos) : (parts.push(text.slice(seg, pos)), parts.join(''));
          pos += 2;
          line += 1;
          fend = BREAK_END;
          fadded = added;
          return;
        }
        // A lone CR is dropped (stray_cr); the field goes on.
        if (parts === null) parts = [];
        parts.push(text.slice(seg, pos));
        added += pos - seg;
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        pos += 1;
        seg = pos;
        continue;
      }
      pos += 1;
    }
    added += pos - seg;
    fval = parts === null ? text.slice(seg, pos) : (parts.push(text.slice(seg, pos)), parts.join(''));
    fend = TEXT_END;
    fadded = added;
  }

  // Reads a quoted field whose opening quote is at pos. Sets fval/fend.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let seg = pos;
    let parts = null;
    let closed = false;
    while (pos < n) {
      const code = text.charCodeAt(pos);
      if (code === 34) {
        // '"'
        if (text.charCodeAt(pos + 1) === 34) {
          if (parts === null) parts = [];
          parts.push(text.slice(seg, pos), '"');
          pos += 2;
          seg = pos;
          continue;
        }
        fval = parts === null ? text.slice(seg, pos) : (parts.push(text.slice(seg, pos)), parts.join(''));
        pos += 1;
        closed = true;
        break;
      }
      if (code === 13) {
        // CRLF and a lone CR inside quotes are each one LF.
        if (parts === null) parts = [];
        parts.push(text.slice(seg, pos), '\n');
        line += 1;
        pos += text.charCodeAt(pos + 1) === 10 ? 2 : 1;
        seg = pos;
        continue;
      }
      if (code === 10) line += 1;
      pos += 1;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      readUnquoted(['"']);
      return;
    }
    if (pos >= n) {
      fend = TEXT_END;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fend = COMMA_END;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fend = BREAK_END;
      return;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fend = BREAK_END;
      return;
    }
    // What follows the closing quote is appended as it stands.
    readUnquoted([fval]);
    if (fadded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const code = text.charCodeAt(pos);
      if (code === 10) {
        pos += 1;
        line += 1;
      } else if (code === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    do {
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        readQuoted();
      } else {
        quoted = false;
        readUnquoted(null);
      }
      fields.push(fval);
    } while (fend === COMMA_END);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
