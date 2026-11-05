#!/usr/bin/env python3
# rules.py <pro>: the rev C design rules, in the project file KiCad and the DSN export read.
import json, sys
p = sys.argv[1]; d = json.load(open(p))
r = d['board']['design_settings']['rules']
r.update(min_resolved_spokes=1, min_clearance=0.09, min_track_width=0.09, min_via_diameter=0.4, min_via_annular_width=0.1, min_through_hole_diameter=0.2,
         min_hole_clearance=0.2, min_hole_to_hole=0.25, min_copper_edge_clearance=0.2, min_connection=0.1)
for c in d['net_settings']['classes']:
    if c['name'] == 'Default':
        c.update(clearance=0.127, track_width=0.15, via_diameter=0.45, via_drill=0.2)
base = [c for c in d['net_settings']['classes'] if c['name'] == 'Default'][0]
d['net_settings']['classes'] = [base, dict(base, name='Power', track_width=0.2, clearance=0.127, via_diameter=0.5, via_drill=0.25, priority=0),
    dict(base, name='Reg', track_width=0.5, clearance=0.15, via_diameter=0.7, via_drill=0.35, priority=1)]
d['net_settings']['netclass_patterns'] = [{'netclass':'Power','pattern':n} for n in ('+3.3V','GND','DVDD','VDDBAT','VREG_AVDD','ADC_AVDD','VREG_LX','VBUS')] + \
    [{'netclass':'Reg','pattern':n} for n in ('/VSYS','+5V')]
d['net_settings']['netclass_assignments'] = None
json.dump(d, open(p, 'w'), indent=2)
