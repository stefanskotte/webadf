/**
 * The facts the pairing guide states, kept in one place with the code that makes them true.
 *
 * Sources: the code lifetime is the pair route's TTL (operator, 2026-11-09: 30 minutes, after a tester's code ran out
 * on slow Wi-Fi). The setup network's name, password and address are the firmware's: main.c / portal_net.c
 * ("wifi-floppy-%02X%02X", the last two bytes of the MAC), the AP passphrase, and dns_server.h PORTAL_IP_* (192.168.4.1).
 * The board's screen shows "Setup needed" and the network's name while it waits (main.c ui_publish DS_PORTAL).
 * The CYW43439 radio is 2.4 GHz only; the setup page refuses open networks (portal_http.c minlength 8).
 */
export const PAIRING_CODE_MINUTES = 30;
export const PAIRING_CODE_TTL_MS = PAIRING_CODE_MINUTES * 60 * 1000;
export const SETUP_NETWORK = 'wifi-floppy-XXXX';
export const SETUP_PASSWORD = 'wififloppy';
export const SETUP_ADDRESS = 'http://192.168.4.1';

/** How often the Devices page asks whether a live code has been used. */
export const PAIRING_POLL_MS = 4000;
