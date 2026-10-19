/**
 * The board's newest failed tag event (fw 1.18.2, firmware nfc_ui.c nfc_ui_why): the reason word(s) -- locked,
 * moved, verify, bad data -- and on a PN532 ":0x<status>@<command>" in upper-case hex, e.g. "locked:0x14@A2".
 * Anything else is refused before it is stored or logged (a status body is device input; a newline in a log
 * line could forge one).
 */
export const NFC_FAIL_RE = /^[a-z]+(?: [a-z]+)?(?::0x[0-9A-F]{2}@[0-9A-F]{2})?$/;
