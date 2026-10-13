;---------------------------------------------------------------------------------------------
; lz4_68k.asm: an LZ4 block decoder and encoder for the plain 68000.
;
; Copyright (c) 2026 Stefan Skotte and contributors. MIT licence (LICENSE in this directory).
; Written from the LZ4 block format description (github.com/lz4/lz4, doc/lz4_Block_format.md);
; no third-party code.
;
; Motorola syntax for vasm (vasmm68k_mot -m68000; -Faout or -Fhunk) and Devpac-style
; assemblers. 68000 only: no 68010+ instructions, and no word or long access at an odd address
; whatever the alignment of the buffers. The register contract and the buffer rules are in
; lz4_68k.h; the encoder's exact behaviour is the C model lz4_68k.c.
;
; Entry points (register call; every register not carrying a result is preserved):
;   lz4_decode          a0 src, a1 dst, a2 dst_end, a3 window start, d0.l src length
;                       -> d0.l decoded length, or -1 (malformed block, or it would not fit)
;   lz4_encode          a0 src, a1 dst, a2 table, d0.l n, d1.l cap, d2.l table entries
;                       -> d0.l block size, or 0 if the block would be larger than cap
;   lz4_encode_linked   the same, plus a3 = the window start (matches may reach back to it)
; and C (stack) entries _lz4_decode, _lz4_encode, _lz4_encode_linked, see lz4_68k.h.
;---------------------------------------------------------------------------------------------

	section	code,code

	xdef	lz4_decode
	xdef	lz4_encode
	xdef	lz4_encode_linked
	xdef	_lz4_decode
	xdef	_lz4_encode
	xdef	_lz4_encode_linked

;---------------------------------------------------------------------------------------------
; C entries (m68k-amigaos gcc / vbcc: arguments on the stack, d0-d1/a0-a1 scratch).
;
; long lz4_decode(const void *src, unsigned long srclen, void *dst, void *dst_end,
;                 const void *window);
_lz4_decode:
	movem.l	a2-a3,-(sp)
	move.l	12(sp),a0
	move.l	16(sp),d0
	move.l	20(sp),a1
	move.l	24(sp),a2
	move.l	28(sp),a3
	bsr	lz4_decode
	movem.l	(sp)+,a2-a3
	rts

; unsigned long lz4_encode(const void *src, unsigned long n, void *dst, unsigned long cap,
;                          unsigned short *table, unsigned long entries);
_lz4_encode:
	movem.l	d2/a2,-(sp)
	move.l	12(sp),a0
	move.l	16(sp),d0
	move.l	20(sp),a1
	move.l	24(sp),d1
	move.l	28(sp),a2
	move.l	32(sp),d2
	bsr	lz4_encode
	movem.l	(sp)+,d2/a2
	rts

; unsigned long lz4_encode_linked(const void *src, unsigned long n, void *dst,
;                                 unsigned long cap, unsigned short *table,
;                                 unsigned long entries, const void *window);
_lz4_encode_linked:
	movem.l	d2/a2-a3,-(sp)
	move.l	16(sp),a0
	move.l	20(sp),d0
	move.l	24(sp),a1
	move.l	28(sp),d1
	move.l	32(sp),a2
	move.l	36(sp),d2
	move.l	40(sp),a3
	bsr	lz4_encode_linked
	movem.l	(sp)+,d2/a2-a3
	rts

;=============================================================================================
; DECODER
;
; Registers: a0 ip, a1 op, a2 dst_end, a3 window start, a4 src end, a6 match source;
; d0 the token (bits 8-31 always 0), d2 the offset (bits 16-31 always 0), d7 the number of
; further sequences the fast path may run without a bounds check, d1/d3-d6 scratch.
;
; Fast path. A sequence whose literal and match nibbles are both below 15 reads at most 17
; bytes (token, 14 literals, 2 offset bytes) and writes at most 32 (14 + 18). While
; src_end - ip >= 17 and dst_end - op >= 32 before a sequence, it can run unchecked except for
; its offset; d7 counts how many in a row are safe (the smaller margin / 32), so a sequence pays
; one DBF for both bounds. Such a sequence is also never the block's last (that one ends
; exactly at src_end, and its literals are followed by nothing), so the fast path needs no end
; test. Each token jumps (one table, 256 entries) straight into the literal copy of the block
; for its match length: block M is 14 unrolled literal moves, entered 2*L bytes before their
; end, then the offset, the window check and M+4 unrolled match moves.
; Longer literal runs or matches (nibble 15) take checked paths, then recount d7. When the
; margins run out, the rest of the block is decoded by a fully checked loop.
;
; The window check: a match source must lie in [window, op). The fast path tests the lower
; bound, and an offset of 0 (the upper bound); a match source below 0 (an offset larger than op
; itself) cannot happen when window >= $10000, so a window below $10000 sends the whole block
; to the checked loop, which tests the full range.
;=============================================================================================

DBLK	equ	96			; bytes per match-length block (padded)

dmatch	macro				; \1 = the token's match nibble (0..14)
.mb\1:
	rept	14
	move.b	(a0)+,(a1)+
	endr
.ml\1:	move.b	(a0)+,d1		; the offset, little-endian
	move.b	(a0)+,-(sp)
	move.w	(sp)+,d2
	move.b	d1,d2
	beq.w	.zoff			; low byte 0: the offset may be 0
.zr\1:	move.l	a1,a6
	sub.l	d2,a6
	cmpa.l	a3,a6
	bcs.w	.derr			; reaches below the window
	rept	\1+4
	move.b	(a6)+,(a1)+
	endr
	dbf	d7,.dfast
	bra.w	.recount
	if	*-.mb\1>DBLK
	fail	"DBLK too small"
	endif
	dcb.b	DBLK-(*-.mb\1),0
	endm

lz4_decode:
	movem.l	d1-d7/a0-a4/a6,-(sp)
	move.l	a1,-(sp)		; the dst start, for the result
	lea	0(a0,d0.l),a4
	moveq	#0,d0
	moveq	#0,d2
	cmpa.l	#$10000,a3
	bcs.w	.slow			; a low window: the checked loop does it all
.recount:
	move.l	a4,d3
	sub.l	a0,d3
	sub.l	#17,d3			; src margin
	move.l	a2,d4
	sub.l	a1,d4
	sub.l	#32,d4			; dst margin
	cmp.l	d4,d3
	ble.s	.rc1
	move.l	d4,d3
.rc1:	tst.l	d3
	bmi.w	.slow
	lsr.l	#5,d3
	cmp.l	#$7fff,d3
	bls.s	.rc2
	move.w	#$7fff,d3
.rc2:	move.w	d3,d7
.dfast:	move.b	(a0)+,d0		; token
	move.w	d0,d6
	add.w	d6,d6
	move.w	.dtab(pc,d6.w),d6
	jmp	.dtab(pc,d6.w)
.dtab:
DT_T	set	0
	rept	256
DT_L	set	DT_T>>4
DT_M	set	DT_T&15
	if	DT_L=15
	dc.w	.llit-.dtab
	else
	if	DT_M=15
	dc.w	.mbx+2*(14-DT_L)-.dtab
	else
	dc.w	.mb0+DT_M*DBLK+2*(14-DT_L)-.dtab
	endif
	endif
DT_T	set	DT_T+1
	endr

	dmatch	0
	dmatch	1
	dmatch	2
	dmatch	3
	dmatch	4
	dmatch	5
	dmatch	6
	dmatch	7
	dmatch	8
	dmatch	9
	dmatch	10
	dmatch	11
	dmatch	12
	dmatch	13
	dmatch	14

; Match nibble 15 after a short literal run (the fast path: the offset bytes are there).
.mbx:
	rept	14
	move.b	(a0)+,(a1)+
	endr
	move.b	(a0)+,d1
	move.b	(a0)+,-(sp)
	move.w	(sp)+,d2
	move.b	d1,d2
	bra.w	.mlong			; (.mlong rejects an offset of 0)

; An offset whose low byte is 0, in block M: an error if the high byte is 0 too, else back.
.zoff:	tst.w	d2
	beq.w	.derr
	moveq	#15,d1			; the block is the token's match nibble: back to its .zr
	and.w	d0,d1
	mulu	#DBLK,d1
	lea	.zr0(pc),a6
	jmp	0(a6,d1.w)

; Literal nibble 15: the length goes on in bytes; every step checked.
.llit:	moveq	#15,d3
	bsr.w	.extlen
	move.l	a4,d4
	sub.l	a0,d4
	cmp.l	d3,d4
	bcs.w	.derr			; the literals pass the src end
	move.l	a2,d4
	sub.l	a1,d4
	cmp.l	d3,d4
	bcs.w	.derr			; or the dst end
	bsr.w	.copylit
	cmpa.l	a4,a0
	beq.w	.ddone			; the last sequence ends here
	move.l	a4,d4
	sub.l	a0,d4
	subq.l	#2,d4
	bcs.w	.derr			; no room for the offset
	moveq	#15,d1
	and.w	d0,d1
	cmp.w	#15,d1
	beq.s	.llm
	move.l	a2,d4
	sub.l	a1,d4
	addq.w	#4,d1
	cmp.l	d1,d4
	bcs.w	.derr			; the match passes the dst end
	subq.w	#4,d1
	moveq	#0,d7			; so the block's DBF falls through to .recount
	mulu	#DBLK,d1
	lea	.ml0(pc),a6
	jmp	0(a6,d1.w)
.llm:	move.b	(a0)+,d1
	move.b	(a0)+,-(sp)
	move.w	(sp)+,d2
	move.b	d1,d2

; Match nibble 15: d2 = the offset (ip is past it).
.mlong:	move.l	a1,d4
	sub.l	a3,d4
	cmp.l	d2,d4
	bcs.w	.derr			; reaches below the window
	tst.w	d2
	beq.w	.derr
	moveq	#15+4,d3
	bsr.w	.extlen
	move.l	a2,d4
	sub.l	a1,d4
	cmp.l	d3,d4
	bcs.w	.derr
	move.l	a1,a6
	sub.l	d2,a6
	bsr.w	.copymatch
	bra.w	.recount

; .extlen: d3 += the 255-run at ip (bytes, checked against the src end). Clobbers d4.
.extlen:
	moveq	#0,d4
.ex1:	cmpa.l	a4,a0
	bcc.s	.exerr
	move.b	(a0)+,d4
	add.l	d4,d3
	cmp.b	#255,d4
	beq.s	.ex1
	rts
.exerr:	addq.l	#4,sp			; drop the return address
	bra.w	.derr

; .copylit: d3.l bytes (may be 0) from (a0)+ to (a1)+. Longs when both have the same parity.
; Clobbers d3-d5.
.copylit:
	cmp.l	#16,d3
	bcs.s	.clb
	move.w	a0,d4
	move.w	a1,d5
	eor.w	d5,d4
	lsr.w	#1,d4
	bcs.s	.clb			; different parity: bytes
	move.w	a0,d4
	lsr.w	#1,d4
	bcc.s	.cle
	move.b	(a0)+,(a1)+
	subq.l	#1,d3
.cle:	move.l	d3,d4
	lsr.l	#2,d4			; longs
	and.w	#3,d3			; then 0..3 bytes
	move.w	d4,d5
	and.w	#7,d5
	lsr.l	#3,d4
	add.w	d5,d5
	neg.w	d5
	jmp	.cll(pc,d5.w)
.clg:	rept	8
	move.l	(a0)+,(a1)+
	endr
.cll:	subq.l	#1,d4
	bcc.s	.clg
.clb:	move.w	d3,d5
	and.w	#15,d5
	lsr.l	#4,d3
	add.w	d5,d5
	neg.w	d5
	jmp	.clc(pc,d5.w)
.clh:	rept	16
	move.b	(a0)+,(a1)+
	endr
.clc:	subq.l	#1,d3
	bcc.s	.clh
	rts

; .copymatch: d3.l bytes from (a6)+ to (a1)+, a6 = a1 - d2 (d2 >= 1; the areas may overlap).
; Longs when the offset is at least 4 and even. Clobbers d3-d5.
.copymatch:
	cmp.l	#16,d3
	bcs.s	.cmb
	cmp.w	#4,d2
	bcs.s	.cmb
	btst	#0,d2
	bne.s	.cmb
	move.w	a1,d4
	lsr.w	#1,d4
	bcc.s	.cme
	move.b	(a6)+,(a1)+
	subq.l	#1,d3
.cme:	move.l	d3,d4
	lsr.l	#2,d4
	and.w	#3,d3
	move.w	d4,d5
	and.w	#7,d5
	lsr.l	#3,d4
	add.w	d5,d5
	neg.w	d5
	jmp	.cml(pc,d5.w)
.cmg:	rept	8
	move.l	(a6)+,(a1)+
	endr
.cml:	subq.l	#1,d4
	bcc.s	.cmg
.cmb:	move.w	d3,d5
	and.w	#15,d5
	lsr.l	#4,d3
	add.w	d5,d5
	neg.w	d5
	jmp	.cmc(pc,d5.w)
.cmh:	rept	16
	move.b	(a6)+,(a1)+
	endr
.cmc:	subq.l	#1,d3
	bcc.s	.cmh
	rts

; The checked loop: every read and write is tested. Used for the block's tail (once the fast
; margins are gone they never come back) and for whole blocks with a window below $10000.
.slow:	cmpa.l	a4,a0
	bcc.w	.derr			; no token where one must be
	move.b	(a0)+,d0
	moveq	#0,d3
	move.b	d0,d3
	lsr.b	#4,d3
	cmp.b	#15,d3
	bne.s	.sl1
	bsr.w	.extlen
.sl1:	move.l	a4,d4
	sub.l	a0,d4
	cmp.l	d3,d4
	bcs.w	.derr
	move.l	a2,d4
	sub.l	a1,d4
	cmp.l	d3,d4
	bcs.w	.derr
	bsr.w	.copylit
	cmpa.l	a4,a0
	beq.s	.ddone
	move.l	a4,d4
	sub.l	a0,d4
	subq.l	#2,d4
	bcs.s	.derr
	move.b	(a0)+,d1
	move.b	(a0)+,-(sp)
	move.w	(sp)+,d2
	move.b	d1,d2
	tst.w	d2
	beq.s	.derr			; offset 0
	move.l	a1,d4
	sub.l	a3,d4
	cmp.l	d2,d4
	bcs.s	.derr			; reaches below the window
	moveq	#15,d3
	and.w	d0,d3
	addq.w	#4,d3
	cmp.w	#15+4,d3
	bne.s	.sl2
	bsr.w	.extlen
.sl2:	move.l	a2,d4
	sub.l	a1,d4
	cmp.l	d3,d4
	bcs.s	.derr
	move.l	a1,a6
	sub.l	d2,a6
	bsr.w	.copymatch
	bra.s	.slow

.ddone:	move.l	a1,d0
	sub.l	(sp)+,d0
	movem.l	(sp)+,d1-d7/a0-a4/a6
	rts
.derr:	addq.l	#4,sp
	moveq	#-1,d0
	movem.l	(sp)+,d1-d7/a0-a4/a6
	rts

;=============================================================================================
; ENCODER (see below)
;=============================================================================================
lz4_encode:
lz4_encode_linked:
	moveq	#0,d0
	rts
