/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
/*
 * NetLoop's hot codec routines in plain 68000 assembly (GNU as, bebbo's m68k-amigaos toolchain).
 * Implemented from the protocol's description; none of RobSmithDev's code is in this program.
 *
 * Each X_asm has exactly the contract of the C X in wifi-floppy/firmware/src/pnet_mfm.c and
 * pnet_frame.c (same outputs, same return values, the same bytes written and no others, no read
 * past the input), which test_netloop_asm checks on an emulated 68000 against the C reference.
 * 68000 only: no 68020 instructions, no word or long access at an odd address (every such access
 * is behind an alignment test), dbra loops widened to 32-bit counts.
 *
 * Calling convention (gcc, m68k-amigaos): arguments on the stack, 4 bytes each, result in d0;
 * d0-d1/a0-a1 are scratch, everything else is saved here.
 *
 * NETLOOP_ASM=1 (build.sh's default): the plain names pnet_X are these routines.
 * NETLOOP_ASM=0: pnet_X jumps to the C reference X_c, and the asm stays callable as X_asm.
 */
#ifndef NETLOOP_ASM
#define NETLOOP_ASM 1
#endif
#define SYNC 0x44894489

	.text
	.even

/* --- size_t pnet_mfm_encode(src, n, dst, uint16_t *last) -------------------------------------
 * One table lookup per byte: entry 2*b + p of pnet_mfm_tab is b's MFM word when the previous
 * word ends in data bit p. p is bit 0 of the previous byte (bit 0 is a data bit). */
	.globl	_pnet_mfm_encode_asm
#if NETLOOP_ASM
	.globl	_pnet_mfm_encode
_pnet_mfm_encode:
#endif
_pnet_mfm_encode_asm:
	movem.l	d2-d4/a2-a3,-(sp)	| args at 24(sp)
	move.l	24(sp),a0		| src
	move.l	28(sp),d1		| n
	move.l	32(sp),a1		| dst
	move.l	36(sp),a2		| last
	lea	_pnet_mfm_tab,a3
	move.l	d1,d4
	add.l	d4,d4			| the result: 2n
	tst.l	d1
	beq	me_out			| n == 0: *last keeps its value
	move.w	(a2),d3			| bit 0: the carry into the first word
	subq.l	#1,d1
	move.l	a1,d2
	btst	#0,d2
	bne	me_odd
me_even:
	lsr.b	#1,d3			| X = previous data bit 0
	moveq	#0,d0			| moveq and move leave X alone
	move.b	(a0)+,d0
	move.b	d0,d3
	addx.w	d0,d0			| 2b + p
	add.w	d0,d0
	move.w	0(a3,d0.w),(a1)+
	dbra	d1,me_even
	sub.l	#0x10000,d1
	bpl	me_even
	bra	me_last
me_odd:					| dst odd: two byte stores
	lsr.b	#1,d3
	moveq	#0,d0
	move.b	(a0)+,d0
	move.b	d0,d3
	addx.w	d0,d0
	add.w	d0,d0
	move.b	0(a3,d0.w),(a1)+
	move.b	1(a3,d0.w),(a1)+
	dbra	d1,me_odd
	sub.l	#0x10000,d1
	bpl	me_odd
me_last:
	move.w	0(a3,d0.w),(a2)		| *last = the last word written
me_out:
	move.l	d4,d0
	movem.l	(sp)+,d2-d4/a2-a3
	rts

/* --- void pnet_mfm_decode(src, n, dst) --------------------------------------------------------
 * out = ((hi & 0x55) << 1) | (lo & 0x55): the data bits of the word hi:lo, in byte order. */
	.globl	_pnet_mfm_decode_asm
#if NETLOOP_ASM
	.globl	_pnet_mfm_decode
_pnet_mfm_decode:
#endif
_pnet_mfm_decode_asm:
	movem.l	d2-d3,-(sp)		| args at 12(sp)
	move.l	12(sp),a0
	move.l	16(sp),d3
	move.l	20(sp),a1
	tst.l	d3
	beq	md_out
	subq.l	#1,d3
	moveq	#0x55,d2
md_loop:
	move.b	(a0)+,d0
	and.b	d2,d0
	add.b	d0,d0
	move.b	(a0)+,d1
	and.b	d2,d1
	or.b	d1,d0
	move.b	d0,(a1)+
	dbra	d3,md_loop
	sub.l	#0x10000,d3
	bpl	md_loop
md_out:
	movem.l	(sp)+,d2-d3
	rts

/* --- uint16_t pnet_checksum(p, len) -----------------------------------------------------------
 * XOR of big-endian words = (XOR of the even bytes) << 8 | (XOR of the odd bytes). An even p
 * XORs 32 bytes per pass as longs and folds the halves; an odd p XORs bytes into two lanes. */
	.globl	_pnet_checksum_asm
#if NETLOOP_ASM
	.globl	_pnet_checksum
_pnet_checksum:
#endif
_pnet_checksum_asm:
	movem.l	d2-d7,-(sp)		| args at 28(sp)
	move.l	28(sp),a0
	move.l	32(sp),d5		| len
	moveq	#0,d0
	tst.l	d5
	beq	cs_out
	move.l	a0,d1
	btst	#0,d1
	bne	cs_odd
	move.l	d5,d1
	lsr.l	#5,d1			| 32-byte blocks
	beq	cs_words
	subq.l	#1,d1
cs_blk:
	movem.l	(a0)+,d2-d4/d6
	eor.l	d2,d0
	eor.l	d3,d0
	eor.l	d4,d0
	eor.l	d6,d0
	movem.l	(a0)+,d2-d4/d6
	eor.l	d2,d0
	eor.l	d3,d0
	eor.l	d4,d0
	eor.l	d6,d0
	dbra	d1,cs_blk
	sub.l	#0x10000,d1
	bpl	cs_blk
cs_words:
	moveq	#31,d1
	and.l	d5,d1
	lsr.w	#1,d1			| whole words left (0..15)
	bra	cs_wtest
cs_w:
	move.w	(a0)+,d2
	eor.w	d2,d0
cs_wtest:
	dbra	d1,cs_w
	btst	#0,d5
	beq	cs_fold
	moveq	#0,d2			| an odd last byte is a high half
	move.b	(a0),d2
	lsl.w	#8,d2
	eor.w	d2,d0
cs_fold:
	move.l	d0,d1
	swap	d1
	eor.w	d1,d0
	and.l	#0xFFFF,d0
	bra	cs_out
cs_odd:
	moveq	#0,d2			| even-index lane (high bytes)
	moveq	#0,d3			| odd-index lane (low bytes)
	move.l	d5,d1
	lsr.l	#1,d1
	beq	cs_otail
	subq.l	#1,d1
cs_op:
	move.b	(a0)+,d4
	eor.b	d4,d2
	move.b	(a0)+,d4
	eor.b	d4,d3
	dbra	d1,cs_op
	sub.l	#0x10000,d1
	bpl	cs_op
cs_otail:
	btst	#0,d5
	beq	cs_ojoin
	move.b	(a0),d4
	eor.b	d4,d2
cs_ojoin:
	move.b	d2,d0
	lsl.w	#8,d0
	move.b	d3,d0
cs_out:
	movem.l	(sp)+,d2-d7
	rts

/* --- size_t pnet_rle_encode(src, n, dst) ------------------------------------------------------
 * The C walks runs; this walks bytes, which decides the same: inside a literal block a run of 3+
 * can only start where a run starts, and a position inside a run of 1 or 2 never starts one.
 *   repeat block: 3+ equal bytes at i (at most 127)            -> count, byte
 *   literal block: up to 127 bytes, ending before the first position j with
 *                  b[j] == b[j+1] == b[j+2] (j + 2 < n), or at n -> 0x80|count, bytes
 * The literal scan stores as it goes, two positions per pass (d1/d2 swap roles), and only looks
 * at b[j+2] when b[j] == b[j+1]. Registers: a0 src, a2 src end, a1 dst, a4 dst start,
 * a3 the literal header, a5 the block start, d7 bytes left, d6 K, d5 S, d4 pass count. */
	.globl	_pnet_rle_encode_asm
#if NETLOOP_ASM
	.globl	_pnet_rle_encode
_pnet_rle_encode:
#endif
_pnet_rle_encode_asm:
	movem.l	d2-d7/a2-a5,-(sp)	| args at 44(sp)
	move.l	44(sp),a0
	move.l	48(sp),d0
	lea	0(a0,d0.l),a2
	move.l	52(sp),a1
	move.l	a1,a4
re_outer:
	move.l	a2,d7
	sub.l	a0,d7			| bytes left
	beq	re_done
	moveq	#3,d0
	cmp.l	d0,d7
	bcs	re_lit
	move.b	(a0),d1
	cmp.b	1(a0),d1
	bne	re_lit
	cmp.b	2(a0),d1
	bne	re_lit
	moveq	#127,d6			| repeat: M = min(127, left)
	cmp.l	d6,d7
	bcc	re_rm
	move.l	d7,d6
re_rm:
	lea	3(a0),a5
	subq.w	#4,d6			| M - 3 more compares
	bmi	re_remit		| M == 3
re_rscan:
	cmp.b	(a5)+,d1
	dbne	d6,re_rscan
	beq	re_remit		| all M equal: a5 = a0 + M
	subq.l	#1,a5			| a5 = the first different byte
re_remit:
	move.l	a5,d0
	sub.l	a0,d0
	move.b	d0,(a1)+
	move.b	d1,(a1)+
	move.l	a5,a0
	bra	re_outer
re_lit:
	move.l	a1,a3			| the header byte, written last
	addq.l	#1,a1
	move.l	a0,a5
	moveq	#127,d6			| K = min(127, left)
	cmp.l	d6,d7
	bcc	re_lk
	move.l	d7,d6
re_lk:
	move.l	d7,d5			| S = min(K, left - 2): positions where a triple fits
	subq.l	#2,d5
	bcc	re_ls
	moveq	#0,d5
re_ls:
	cmp.l	d6,d5
	bls	re_ls2
	move.l	d6,d5
re_ls2:
	tst.w	d5
	beq	re_ltail
	move.w	d5,d4
	addq.w	#1,d4
	lsr.w	#1,d4
	subq.w	#1,d4			| ceil(S / 2) - 1
	btst	#0,d5
	bne	re_lodd
	move.b	(a0)+,d1		| even S: start in half A (d1 = b[j])
	bra	re_LA
re_lodd:
	move.b	(a0)+,d2		| odd S: start in half B (d2 = b[j])
	bra	re_LB
re_LA:
	move.b	(a0)+,d2		| b[j+1]
	cmp.b	d1,d2
	beq	re_PA
re_SA:
	move.b	d1,(a1)+		| b[j] is literal
re_LB:
	move.b	(a0)+,d1
	cmp.b	d2,d1
	beq	re_PB
re_SB:
	move.b	d2,(a1)+
	dbra	d4,re_LA
	bra	re_ltail
re_PA:
	cmp.b	(a0),d1			| a pair: is b[j+2] the same?
	bne	re_SA
	bra	re_lend
re_PB:
	cmp.b	(a0),d2
	bne	re_SB
	bra	re_lend
re_ltail:				| all S positions literal: the K - S (<= 2) after them too
	move.l	d6,d0
	sub.l	d5,d0
	beq	re_lend
	lea	0(a5,d5.l),a0
	subq.w	#1,d0
re_lt:
	move.b	(a0)+,(a1)+
	dbra	d0,re_lt
re_lend:
	move.l	a1,d0
	sub.l	a3,d0
	subq.l	#1,d0			| the block's length
	lea	0(a5,d0.l),a0
	or.b	#0x80,d0
	move.b	d0,(a3)
	bra	re_outer
re_done:
	move.l	a1,d0
	sub.l	a4,d0
	btst	#0,d0
	beq	re_out
	clr.b	(a1)+			| even length: one no-op control byte
	addq.l	#1,d0
re_out:
	movem.l	(sp)+,d2-d7/a2-a5
	rts

/* --- long pnet_rle_decode(src, n, dst, cap) ---------------------------------------------------
 * Checks in the C order (cap, then input left) before touching dst, so a failing block writes
 * nothing. Copies jump into unrolled runs of moves: bytes, or longs when src and dst have the
 * same parity. Registers: a0 src, a2 src end, a1 dst, a4 dst start, d6 cap left,
 * a3/a5/a6 the ends of the byte-copy, fill and long-copy runs. */
	.globl	_pnet_rle_decode_asm
#if NETLOOP_ASM
	.globl	_pnet_rle_decode
_pnet_rle_decode:
#endif
_pnet_rle_decode_asm:
	movem.l	d2-d7/a2-a6,-(sp)	| args at 48(sp)
	move.l	48(sp),a0
	move.l	52(sp),d0
	lea	0(a0,d0.l),a2
	move.l	56(sp),a1
	move.l	a1,a4
	move.l	60(sp),d6
	lea	rd_cend(pc),a3
	lea	rd_fend(pc),a5
	lea	rd_lend(pc),a6
rd_next:
	cmpa.l	a2,a0
	bcc	rd_done
	moveq	#0,d0
	move.b	(a0)+,d0		| control byte
	moveq	#0x7F,d1
	and.b	d0,d1			| k
	beq	rd_next			| the even-length pad
	cmp.l	d6,d1
	bhi	rd_fail			| k > cap - o
	sub.l	d1,d6
	tst.b	d0
	bmi	rd_lit
	cmpa.l	a2,a0
	bcc	rd_fail			| no byte to repeat
	move.b	(a0)+,d2
	add.w	d1,d1
	neg.w	d1
	jmp	0(a5,d1.w)		| the last k fills
rd_lit:
	move.l	a2,d2
	sub.l	a0,d2
	cmp.l	d2,d1
	bhi	rd_fail			| k > n - i
	move.l	a0,d2
	move.l	a1,d3
	eor.b	d3,d2
	btst	#0,d2
	bne	rd_bytes		| different parity: bytes
	cmp.w	#8,d1
	bcs	rd_bytes
	move.l	a0,d2
	btst	#0,d2
	beq	rd_even
	move.b	(a0)+,(a1)+		| both odd: one byte makes both even
	subq.w	#1,d1
rd_even:
	move.w	d1,d3
	lsr.w	#2,d3			| longs (<= 31)
	and.w	#3,d1			| then 0..3 bytes
	add.w	d3,d3
	neg.w	d3
	jmp	0(a6,d3.w)
rd_bytes:
	add.w	d1,d1
	neg.w	d1
	jmp	0(a3,d1.w)
	.rept	31
	move.l	(a0)+,(a1)+
	.endr
rd_lend:
	add.w	d1,d1
	neg.w	d1
	jmp	0(a3,d1.w)
	.rept	127
	move.b	(a0)+,(a1)+
	.endr
rd_cend:
	bra	rd_next
	.rept	127
	move.b	d2,(a1)+
	.endr
rd_fend:
	bra	rd_next
rd_done:
	move.l	a1,d0
	sub.l	a4,d0
	bra	rd_out
rd_fail:
	moveq	#-1,d0
rd_out:
	movem.l	(sp)+,d2-d7/a2-a6
	rts

/* --- long pnet_find_sync(b, len, scan) --------------------------------------------------------
 * The C shifts a 32-bit register one bit at a time. Here: a sync starting at bit p = 8q - s
 * (s = 0..7) holds byte b[q] whole, and that byte is one of seven values (pnet_sync_tab). Scan
 * bytes against the table; at a hit try its offsets, smallest p first (s = 7 down to 0), and
 * only those whose last bit lies inside limit = min(scan + 4, len) bytes. The first match is the
 * C's (the smallest end bit). Registers: a3 b, d6 8 * limit, d7 bytes left. */
	.globl	_pnet_find_sync_asm
#if NETLOOP_ASM
	.globl	_pnet_find_sync
_pnet_find_sync:
#endif
_pnet_find_sync_asm:
	movem.l	d2-d7/a2-a3,-(sp)	| args at 36(sp)
	move.l	36(sp),a0
	move.l	40(sp),d0		| len
	move.l	44(sp),d7		| scan
	addq.l	#4,d7
	cmp.l	d0,d7
	bcs	fs_lim
	move.l	d0,d7			| limit = scan + 4 < len ? scan + 4 : len
fs_lim:
	tst.l	d7
	beq	fs_none
	move.l	d7,d6
	lsl.l	#3,d6			| the last bit must end at or before 8 * limit
	move.l	a0,a3
	lea	_pnet_sync_tab,a2
	subq.l	#1,d7
	moveq	#0,d0
fs_loop:
	move.b	(a0)+,d0
	move.b	0(a2,d0.w),d1
	dbne	d7,fs_loop
	bne	fs_cand
	sub.l	#0x10000,d7
	bpl	fs_loop
fs_none:
	moveq	#-1,d0
	bra	fs_out
fs_cand:
	move.l	a0,d5
	sub.l	a3,d5
	subq.l	#1,d5
	lsl.l	#3,d5			| 8q
	moveq	#7,d2			| s
fs_s:
	btst	d2,d1
	beq	fs_snext
	tst.w	d2
	beq	fs_s0
	tst.l	d5
	beq	fs_snext		| q == 0: the sync would start before b
	move.l	d5,d3
	sub.l	d2,d3
	add.l	#32,d3			| its end bit
	cmp.l	d6,d3
	bhi	fs_snext
	lea	-2(a0),a1		| b[q-1..q+3]
	move.b	(a1)+,d4
	lsl.w	#8,d4
	move.b	(a1)+,d4
	swap	d4
	move.b	(a1)+,d4
	lsl.w	#8,d4
	move.b	(a1)+,d4
	moveq	#0,d0
	move.b	(a1),d0
	lsr.b	d2,d0
	moveq	#8,d3
	sub.w	d2,d3
	lsl.l	d3,d4
	or.b	d0,d4			| the 32 bits from bit 8q - s
	cmp.l	#SYNC,d4
	bne	fs_snext
	move.l	d5,d0
	sub.l	d2,d0
	add.l	#32,d0
	bra	fs_out
fs_snext:
	dbra	d2,fs_s
	bra	fs_resume
fs_s0:
	move.l	d5,d3
	add.l	#32,d3
	cmp.l	d6,d3
	bhi	fs_resume
	lea	-1(a0),a1		| b[q..q+3]
	move.b	(a1)+,d4
	lsl.w	#8,d4
	move.b	(a1)+,d4
	swap	d4
	move.b	(a1)+,d4
	lsl.w	#8,d4
	move.b	(a1)+,d4
	cmp.l	#SYNC,d4
	bne	fs_resume
	move.l	d3,d0
	bra	fs_out
fs_resume:
	moveq	#0,d0
	dbra	d7,fs_loop		| dbne stopped without counting this byte
	sub.l	#0x10000,d7
	bpl	fs_loop
	bra	fs_none
fs_out:
	movem.l	(sp)+,d2-d7/a2-a3
	rts

/* --- size_t pnet_shift_left(b, len, bits) -----------------------------------------------------
 * valid = len - q - (r ? 1 : 0) bytes, b[i] = the 8 bits at bit offset bits + 8i (q = bits >> 3,
 * r = bits & 7). For an even b, counted from the even byte qe = q & ~1 the shift is s = bits -
 * 8 qe (0..15), and output word k is bits s..s+15 of the long W[k]:W[k+1]: one 32-bit shift per
 * two bytes, in an 8-way unrolled loop entered Duff-style. s == 0 is a long copy. The words whose
 * W[k+1] would end past len, and every odd b, take the byte formula. In place is safe: each
 * store lands below every byte still to be read. */
	.globl	_pnet_shift_left_asm
#if NETLOOP_ASM
	.globl	_pnet_shift_left
_pnet_shift_left:
#endif
_pnet_shift_left_asm:
	movem.l	d2-d7/a2-a3,-(sp)	| args at 36(sp)
	move.l	36(sp),a1		| b
	move.l	40(sp),d6		| len
	move.l	44(sp),d7		| bits
	move.l	d7,d5
	lsr.l	#3,d5			| q
	moveq	#7,d4
	and.l	d7,d4			| r
	cmp.l	d6,d5
	bcc	sl_zero
	move.l	d6,d3
	sub.l	d5,d3
	tst.w	d4
	beq	sl_v
	subq.l	#1,d3
sl_v:
	move.l	d3,a2			| valid: the result
	tst.l	d3
	beq	sl_ret
	move.l	a1,d0
	btst	#0,d0
	bne	sl_bytes		| odd b: the byte formula throughout
	move.l	d5,d0
	bclr	#0,d0			| qe
	move.l	d4,d2
	btst	#0,d5
	beq	sl_s
	addq.w	#8,d2			| s = r + 8 (q & 1)
sl_s:
	lea	0(a1,d0.l),a0		| W[0]
	tst.w	d2
	beq	sl_copy
	move.l	d6,d1
	sub.l	d0,d1
	subq.l	#2,d1			| (len - qe - 2) / 2 words have W[k+1] inside len
	bcs	sl_tail0
	lsr.l	#1,d1
	move.l	d3,d0
	lsr.l	#1,d0
	cmp.l	d0,d1
	bls	sl_f
	move.l	d0,d1			| F = min(valid / 2, that)
sl_f:
	tst.l	d1
	beq	sl_tail0
	sub.l	d1,d3
	sub.l	d1,d3			| bytes left for the tail: valid - 2F
	move.l	d1,d7
	addq.l	#7,d7
	lsr.l	#3,d7
	subq.l	#1,d7			| passes of 8
	move.l	d1,d6
	neg.l	d6
	and.w	#7,d6			| bodies to skip in the first pass
	move.w	(a0)+,d0
	cmp.w	#8,d2
	bcc	sl_B
	lea	sl_Aloop(pc),a3
	mulu	#12,d6
	jmp	0(a3,d6.w)
sl_Aloop:				| s = 1..7: high word of (W[k]:W[k+1]) << s
	.rept	8
	swap	d0
	move.w	(a0)+,d0
	move.l	d0,d1
	lsl.l	d2,d1
	swap	d1
	move.w	d1,(a1)+
	.endr
	dbra	d7,sl_Aloop
	sub.l	#0x10000,d7
	bpl	sl_Aloop
	bra	sl_tail
sl_B:					| s = 8..15: low word of (W[k]:W[k+1]) >> (16 - s)
	neg.w	d2
	add.w	#16,d2
	lea	sl_Bloop(pc),a3
	mulu	#10,d6
	jmp	0(a3,d6.w)
sl_Bloop:
	.rept	8
	swap	d0
	move.w	(a0)+,d0
	move.l	d0,d1
	lsr.l	d2,d1
	move.w	d1,(a1)+
	.endr
	dbra	d7,sl_Bloop
	sub.l	#0x10000,d7
	bpl	sl_Bloop
	bra	sl_tail
sl_copy:				| s == 0: valid bytes from b + q, forward
	move.l	d3,d0
	lsr.l	#2,d0
	beq	sl_cw
	subq.l	#1,d0
sl_cl:
	move.l	(a0)+,(a1)+
	dbra	d0,sl_cl
	sub.l	#0x10000,d0
	bpl	sl_cl
sl_cw:
	btst	#1,d3
	beq	sl_cb
	move.w	(a0)+,(a1)+
sl_cb:
	btst	#0,d3
	beq	sl_ret
	move.b	(a0)+,(a1)+
	bra	sl_ret
sl_tail0:
sl_tail:				| a1 = b + i, d3 = valid - i bytes by the byte formula
	tst.l	d3
	beq	sl_ret
sl_bytes:
	lea	0(a1,d5.l),a0		| b + i + q
	subq.l	#1,d3
	tst.w	d4
	beq	sl_bc
	moveq	#8,d2
	sub.w	d4,d2			| 8 - r
	move.b	(a0)+,d0
sl_bl:
	move.b	(a0)+,d1
	lsl.b	d4,d0
	move.b	d1,d6
	lsr.b	d2,d6
	or.b	d6,d0
	move.b	d0,(a1)+
	move.b	d1,d0
	dbra	d3,sl_bl
	sub.l	#0x10000,d3
	bpl	sl_bl
	bra	sl_ret
sl_bc:
	move.b	(a0)+,(a1)+
	dbra	d3,sl_bc
	sub.l	#0x10000,d3
	bpl	sl_bc
	bra	sl_ret
sl_zero:
	sub.l	a2,a2
sl_ret:
	move.l	a2,d0
	movem.l	(sp)+,d2-d7/a2-a3
	rts

/* --- int nl_memeq(a, b, n): 1 when equal --------------------------------------------------- */
	.globl	_nl_memeq_asm
_nl_memeq_asm:
	movem.l	d2,-(sp)		| args at 8(sp)
	move.l	8(sp),a0
	move.l	12(sp),a1
	move.l	16(sp),d1
	move.l	a0,d0
	move.l	a1,d2
	or.l	d2,d0
	btst	#0,d0
	bne	eq_bytes
	move.l	d1,d0
	lsr.l	#4,d0
	beq	eq_rest
	subq.l	#1,d0
eq_l:
	cmpm.l	(a0)+,(a1)+
	bne	eq_no
	cmpm.l	(a0)+,(a1)+
	bne	eq_no
	cmpm.l	(a0)+,(a1)+
	bne	eq_no
	cmpm.l	(a0)+,(a1)+
	bne	eq_no
	dbra	d0,eq_l
	sub.l	#0x10000,d0
	bpl	eq_l
eq_rest:
	moveq	#15,d0
	and.l	d0,d1
eq_bytes:
	tst.l	d1
	beq	eq_yes
	subq.l	#1,d1
eq_b:
	cmpm.b	(a0)+,(a1)+
	dbne	d1,eq_b
	bne	eq_no
	sub.l	#0x10000,d1
	bpl	eq_b
eq_yes:
	moveq	#1,d0
	bra	eq_out
eq_no:
	moveq	#0,d0
eq_out:
	movem.l	(sp)+,d2
	rts

#if !NETLOOP_ASM
/* The C build: the plain names are the reference. */
	.globl	_pnet_mfm_encode, _pnet_mfm_decode, _pnet_checksum, _pnet_rle_encode
	.globl	_pnet_rle_decode, _pnet_find_sync, _pnet_shift_left
_pnet_mfm_encode:	jmp	_pnet_mfm_encode_c
_pnet_mfm_decode:	jmp	_pnet_mfm_decode_c
_pnet_checksum:		jmp	_pnet_checksum_c
_pnet_rle_encode:	jmp	_pnet_rle_encode_c
_pnet_rle_decode:	jmp	_pnet_rle_decode_c
_pnet_find_sync:	jmp	_pnet_find_sync_c
_pnet_shift_left:	jmp	_pnet_shift_left_c
#endif
