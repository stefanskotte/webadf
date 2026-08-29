#ifndef FLOPPY_IO_H
#define FLOPPY_IO_H
// ---- pin map (matches rev A PCB) --------------------------------------
// Inputs via 74LVC541A, same polarity as bus (active-low signals read 0).
#define PIN_SEL0    2
#define PIN_SEL1    3
#define PIN_MTR     4
#define PIN_DIR     5      // high = step outwards (towards track 0) per Shugart DIRC
#define PIN_STEP    6
#define PIN_WDATA   7      // PIO capture
#define PIN_WGATE   8
#define PIN_SIDE    9      // low = side 1 (upper head)
// Outputs drive BSS138 gates: GPIO HIGH  ->  bus line pulled LOW (asserted).
#define PIN_WPROT   10
#define PIN_RDATA   11     // PIO side-set
#define PIN_RDY     12
#define PIN_TRK0    13
#define PIN_INDEX   0      // north-edge pin; GP14/15 sit in antenna keepout
#define PIN_CHNG    1

#define OUT_ASSERT   1     // remember: inverted driver
#define OUT_RELEASE  0

#define NUM_CYL      80
#define NUM_SIDES    2
#define RPM          300
#define REV_US       200000            // 200 ms / rev
#define BITCELL_NS   2000              // Amiga DD MFM
#define TRACK_MFM_MAX 13000            // bytes, DD raw MFM upper bound
#define INDEX_PULSE_US 2000
#endif
