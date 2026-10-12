"""A Workbench project icon from a tool icon: the same picture, do_Type WBPROJECT,
and a default tool. Usage: make_icon.py <tool.info> <default tool> <out.info>

The input must be a plain OS 2+ tool icon with no default tool, no tool types and
no drawer data (Rob's "PaulaNET Config.info" is one); anything else is refused.
After the images, an icon carries its default tool as a ULONG length (with the NUL)
and the string -- so that is appended, and do_DefaultTool is made non-zero."""
import struct, sys

src, tool, out = sys.argv[1], sys.argv[2], sys.argv[3]
d = bytearray(open(src, 'rb').read())
magic, ver = struct.unpack('>HH', d[0:4])
do_type = d[48]
deftool, tooltypes = struct.unpack('>II', d[50:58])
drawer = struct.unpack('>I', d[66:70])[0]
if (magic, ver, do_type, deftool, tooltypes, drawer) != (0xE310, 1, 3, 0, 0, 0) or b'FORM' in d:
    sys.exit('make_icon: %s is not a plain tool icon' % src)
d[48] = 4                                  # WBPROJECT
struct.pack_into('>I', d, 50, 0x00000001)  # do_DefaultTool: non-zero = present
struct.pack_into('>II', d, 58, 0x80000000, 0x80000000)  # NO_ICON_POSITION: Workbench places it
s = tool.encode('ascii') + b'\x00'
d += struct.pack('>I', len(s)) + s
open(out, 'wb').write(bytes(d))
