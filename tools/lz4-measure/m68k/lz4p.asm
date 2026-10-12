;---------------------------------------------------------------------------------------------
; lz4p.asm: a PROTOTYPE LZ4 block compressor for the plain 68000 (research; not product code).
;
; Copyright (c) 2026 the webadf authors. MIT licence (the repository's LICENSE); written for
; webadf and offered to RobSmithDev for PaulaNET.device. Written from the public LZ4 block format
; description (github.com/lz4/lz4, doc/lz4_Block_format.md); no LZ4 library code.
;
; Bit-exact with the C model tools/lz4-measure/lz4p.c (same algorithm, same bytes, same give-up
; decisions); lz4bench checks that under vamos. Motorola syntax for vasm (vasmm68k_mot) / Devpac.
; 68000 only: no 68020 instructions; every word or long access is at an even address, provided
; src is at an even address.
;
; Register entry, lz4p_encode:
;   in:  a0 src (even address), a1 dst, a2 hash table (LZ4P_HASH words, any contents, kept
;        between calls), d0.l n (<= 65535), d1.l cap (bytes dst may take)
;   out: d0.l the LZ4 block's size, or 0 if it would not fit in cap (send something else)
;   all other registers preserved
; C entry, _lz4p_encode_asm(src, n, dst, cap, tab): the same, arguments on the stack (gcc/vbcc
; m68k-amigaos convention), result in d0.
;---------------------------------------------------------------------------------------------
LZ4P_HASH	equ	1024

	section	code,code
	xdef	_lz4p_encode_asm
	xdef	lz4p_encode

_lz4p_encode_asm:
	movem.l	a2,-(sp)
	move.l	8(sp),a0
	move.l	12(sp),d0
	move.l	16(sp),a1
	move.l	20(sp),d1
	move.l	24(sp),a2
	bsr.s	lz4p_encode
	movem.l	(sp)+,a2
	rts

; Registers in the body: a0 ip, a1 op, a2 table, a3 dst + cap, a4 src, a5 anchor, a6 ref,
; d5 src + n - 12 (the last match start), d6 src + n - 5 (where matches stop), d7 misses since
; the last match, d0-d4 scratch. The dst start is on the stack.
lz4p_encode:
	movem.l	d2-d7/a2-a6,-(sp)
	move.l	a1,-(sp)
	lea	0(a1,d1.l),a3
	move.l	a0,a4
	move.l	a0,a5
	lea	-5(a0,d0.l),a6
	move.l	a6,d6
	lea	-12(a0,d0.l),a6
	move.l	a6,d5
	moveq	#0,d7
	cmp.l	#13,d0
	blo	.last

.loop:	cmpa.l	d5,a0
	bhi	.last
	move.l	a0,d0
	sub.l	a4,d0			; pos
	btst	#0,d0
	bne.s	.odd
	move.l	(a0),d3			; v, big-endian
	bra.s	.hash
.odd:	move.l	-1(a0),d3
	lsl.l	#8,d3
	move.b	3(a0),d3
.hash:	move.l	d3,d1
	swap	d1
	eor.w	d3,d1			; x = hi ^ lo
	move.w	d1,d2
	lsr.w	#5,d2
	eor.w	d2,d1
	and.w	#(LZ4P_HASH-1),d1
	add.w	d1,d1
	moveq	#0,d2
	move.w	0(a2,d1.w),d2		; ref
	move.w	d0,0(a2,d1.w)		; tab[h] = pos
	cmp.l	d0,d2
	bhs.s	.miss			; ref >= pos: not a candidate
	lea	0(a4,d2.l),a6
	btst	#0,d2
	bne.s	.rodd
	cmp.l	(a6),d3
	beq.s	.match
	bra.s	.miss
.rodd:	move.l	-1(a6),d1
	lsl.l	#8,d1
	move.b	3(a6),d1
	cmp.l	d1,d3
	beq.s	.match
.miss:	move.l	d7,d1
	lsr.l	#6,d1
	addq.l	#1,d1
	add.l	d1,a0			; pos += 1 + (misses >> 6)
	addq.l	#1,d7
	bra.s	.loop

.match:	move.l	a0,d0			; the match's start
	addq.l	#4,a0
	addq.l	#4,a6
	move.l	d6,d1
	sub.l	a0,d1			; bytes before src + n - 5 (> 0)
	subq.w	#1,d1
.fwd:	cmpm.b	(a6)+,(a0)+
	dbne	d1,.fwd
	beq.s	.fwdone			; ran to the limit, all equal
	subq.l	#1,a0			; the mismatch: step back
	subq.l	#1,a6
.fwdone:
	move.l	a0,d4
	sub.l	a6,d4			; off = ip - ref
	move.l	d0,a6			; a6: the match start, moved back below
	move.l	d4,d3
	add.l	a4,d3			; ref > src  <=>  start > src + off
	cmp.l	a5,d3
	bhs.s	.bound
	move.l	a5,d3			; and start > anchor
.bound:	neg.l	d4
.back:	cmpa.l	d3,a6
	bls.s	.bkdone
	move.b	-1(a6,d4.l),d1
	cmp.b	-1(a6),d1
	bne.s	.bkdone
	subq.l	#1,a6
	bra.s	.back
.bkdone:
	neg.l	d4
	move.l	a6,d1
	sub.l	a5,d1			; lit
	move.l	a0,d2
	sub.l	a6,d2
	subq.l	#4,d2			; ml
	move.l	d1,d3			; need = 5 + lit + lit/128 + ml/128 (>= the true size)
	lsr.l	#7,d3
	add.l	d1,d3
	move.l	d2,d0
	lsr.l	#7,d0
	add.l	d0,d3
	addq.l	#5,d3
	move.l	a3,d0
	sub.l	a1,d0
	cmp.l	d0,d3
	bhi	.fail
	moveq	#15,d3			; token
	cmp.l	d3,d1
	bhs.s	.t1
	move.l	d1,d3
.t1:	lsl.b	#4,d3
	moveq	#15,d0
	cmp.l	d0,d2
	bhs.s	.t2
	move.l	d2,d0
.t2:	or.b	d0,d3
	move.b	d3,(a1)+
	moveq	#15,d0
	cmp.l	d0,d1
	blo.s	.nolx
	move.l	d1,d0
	sub.l	#15,d0
	bsr	putlen
.nolx:	bsr	copylit			; lit bytes from the anchor
	move.b	d4,(a1)+		; offset, little-endian
	move.w	d4,d0
	lsr.w	#8,d0
	move.b	d0,(a1)+
	moveq	#15,d0
	cmp.l	d0,d2
	blo.s	.nomx
	move.l	d2,d0
	sub.l	#15,d0
	bsr	putlen
.nomx:	move.l	a0,a5			; anchor = ip = the match's end
	moveq	#0,d7
	bra	.loop

.last:	move.l	d6,d1
	addq.l	#5,d1
	sub.l	a5,d1			; lit = n - anchor
	move.l	d1,d3			; need = 2 + lit + lit/128
	lsr.l	#7,d3
	add.l	d1,d3
	addq.l	#2,d3
	move.l	a3,d0
	sub.l	a1,d0
	cmp.l	d0,d3
	bhi.s	.fail
	moveq	#15,d3
	cmp.l	d3,d1
	bhs.s	.t3
	move.l	d1,d3
.t3:	lsl.b	#4,d3
	move.b	d3,(a1)+
	moveq	#15,d0
	cmp.l	d0,d1
	blo.s	.nolx2
	move.l	d1,d0
	sub.l	#15,d0
	bsr	putlen
.nolx2:	bsr	copylit
	move.l	a1,d0
	sub.l	(sp)+,d0		; the block's size
	movem.l	(sp)+,d2-d7/a2-a6
	rts
.fail:	addq.l	#4,sp
	moveq	#0,d0
	movem.l	(sp)+,d2-d7/a2-a6
	rts

; putlen: d0.l >= 0 as the LZ4 length run (255s, then the rest) at (a1)+. Clobbers d0.
putlen:	cmp.l	#255,d0
	blo.s	.end
.ff:	st	(a1)+
	sub.l	#255,d0
	cmp.l	#255,d0
	bhs.s	.ff
.end:	move.b	d0,(a1)+
	rts

; copylit: d1.l (< 65536) bytes from (a5)+ to (a1)+. Longs when both have the same parity and
; there are 12 or more, else bytes; both through unrolled runs of 8. Clobbers d0, d1, d3.
copylit:
	move.l	a5,d0
	move.l	a1,d3
	eor.b	d3,d0
	btst	#0,d0
	bne.s	.bytes
	cmp.l	#12,d1
	blo.s	.bytes
	move.l	a5,d0
	btst	#0,d0
	beq.s	.even
	move.b	(a5)+,(a1)+
	subq.l	#1,d1
.even:	move.l	d1,d3
	lsr.l	#2,d3			; longs
	and.w	#3,d1			; then 0..3 bytes
	move.w	d3,d0
	and.w	#7,d0
	lsr.l	#3,d3
	add.w	d0,d0
	neg.w	d0
	jmp	.lend(pc,d0.w)
.lgrp:	rept	8
	move.l	(a5)+,(a1)+
	endr
.lend:	subq.l	#1,d3
	bcc.s	.lgrp
.bytes:	move.w	d1,d0
	and.w	#7,d0
	lsr.l	#3,d1
	add.w	d0,d0
	neg.w	d0
	jmp	.bend(pc,d0.w)
.bgrp:	rept	8
	move.b	(a5)+,(a1)+
	endr
.bend:	subq.l	#1,d1
	bcc.s	.bgrp
	rts
