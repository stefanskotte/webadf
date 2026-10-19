#ifndef RX_NAMES_H
#define RX_NAMES_H
#define RX_PART_MAX 30
#define RX_PATH_MAX 255
/* 1 if path is a safe relative path: 1..255 bytes, '/'-separated parts of 1..30 bytes, no ':', no byte < 0x20
   or 0x7f, no part "." or "..", no leading, trailing or double '/'. */
int rx_path_ok(const char *path);
/* Candidate n for path into out[RX_PATH_MAX+1]: n <= 1 is path itself; n >= 2 puts "_n" before the last part's
   extension (its last '.', unless that dot starts the name), cutting the stem so the part stays <= 30 bytes.
   Returns 0, or -1 if it cannot fit. */
int rx_candidate(const char *path, unsigned n, char *out);
/* The name an Amiga path goes up under, into out[RX_PART_MAX+1]: its last part, trailing '/'s ignored (Shell TAB
   completion adds one); for a bare volume ("DH0:") the volume's name. Cut to RX_PART_MAX bytes. */
void rx_base_name(const char *path, char *out);
/* Decimal digits of v and a NUL into out (>= 11 bytes); returns the number of digits. */
unsigned rx_utoa(unsigned long v, char *out);
#endif
