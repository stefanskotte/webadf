import { describe, it, expect } from 'vitest';
import { downloadFilename, contentDisposition } from './download-name';

const SHA = 'a'.repeat(64);

describe('downloadFilename', () => {
  it('prefers the canonical TOSEC name', () => {
    expect(downloadFilename('9 Fingers (1993)(Spaceballs).adf', '9Fingers_D1.adf', SHA))
      .toBe('9 Fingers (1993)(Spaceballs).adf');
  });

  it('falls back to what the tenant uploaded when TOSEC does not know the disk', () => {
    // 54% of a real archive has no TOSEC name at all.
    expect(downloadFilename(null, '9Fingers_D1.adf', SHA)).toBe('9Fingers_D1.adf');
  });

  it('falls back to the digest when neither name exists', () => {
    expect(downloadFilename(null, null, SHA)).toBe(`${SHA}.adf`);
  });

  it('appends .adf when a stored name lacks it', () => {
    // Nothing guarantees the extension: sourceFilename is whatever the
    // uploader sent, and a saved file with no extension is unhelpful.
    expect(downloadFilename(null, 'Workbench31', SHA)).toBe('Workbench31.adf');
  });

  it('does not double up an existing extension, whatever its case', () => {
    expect(downloadFilename(null, 'Real_Amiga_Install.ADF', SHA)).toBe('Real_Amiga_Install.ADF');
  });

  it('ignores an empty or whitespace-only stored name', () => {
    expect(downloadFilename('', '   ', SHA)).toBe(`${SHA}.adf`);
  });

  it('strips any path, so a stored name cannot suggest a directory', () => {
    expect(downloadFilename(null, '../../etc/passwd', SHA)).toBe('passwd.adf');
    expect(downloadFilename(null, 'C:\\games\\x.adf', SHA)).toBe('x.adf');
  });

  it('appends no extension when the caller asks for none', () => {
    // A file inside a disk is not an ADF: "startup-sequence" must stay itself.
    expect(downloadFilename('startup-sequence', null, SHA, '')).toBe('startup-sequence');
  });

  it('still defaults to .adf for a whole disk', () => {
    expect(downloadFilename(null, 'Workbench31', SHA)).toBe('Workbench31.adf');
  });
});

describe('contentDisposition', () => {
  it('quotes the ASCII form and adds the RFC 5987 form', () => {
    const h = contentDisposition('Turrican II.adf');
    expect(h).toContain('attachment; filename="Turrican II.adf"');
    expect(h).toContain("filename*=UTF-8''Turrican%20II.adf");
  });

  it('cannot be broken out of by a quote in the name', () => {
    // sourceFilename is whatever the uploader sent. A bare quote would end
    // the quoted-string early and let the rest be read as header parameters.
    const h = contentDisposition('evil".adf');
    expect(h).toContain('filename="evil_.adf"');
  });

  it('cannot inject a second header via CR or LF', () => {
    // The attack that matters: a newline in a response header splits it, and
    // everything after the break is read as a header of its own.
    //
    // The property is the ABSENCE OF LINE BREAKS, not the absence of the
    // word. Text that looks like a header is inert while it sits inside a
    // quoted string on a single line -- and a real file could legitimately
    // be named that. Asserting on the word would fail an honest filename
    // while proving nothing about the actual vulnerability.
    const h = contentDisposition('a\r\nSet-Cookie: x=1.adf');
    expect(h).not.toMatch(/[\r\n]/);
    expect(h.split(/\r?\n/)).toHaveLength(1);
  });

  it('keeps non-ASCII in the encoded form and degrades the plain one', () => {
    // TOSEC names carry accents; the quoted form is ASCII-only by spec, so
    // the UTF-8 parameter is what actually preserves the name.
    const h = contentDisposition('Café.adf');
    expect(h).toContain("filename*=UTF-8''Caf%C3%A9.adf");
    expect(h).toMatch(/filename="Caf.?\.adf"/);
  });
});
