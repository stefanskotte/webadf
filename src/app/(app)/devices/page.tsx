import { uploadSummaries } from '@/lib/amiga-uploads';
import { cardUploadLine } from '@/lib/from-amiga-ui';
import { nowMs } from '@/lib/clock';
import { getDb } from '@/db';
import { sendSummaries } from '@/lib/transfers';
import { listSendTargets } from '@/lib/send-targets';
import { cardSendLine, receiverRunning } from '@/lib/send-ui';
import { requireOrg } from '@/lib/session';
import { getUserPrefs } from '@/lib/user-prefs';
import { listDevices } from '@/lib/queries';
import { listReleases } from '@/lib/firmware-releases';
import { firmwareState, countBehind, buildRegistry } from '@/lib/firmware-state';
import { refuseTarget } from '@/lib/firmware-update-rules';
import { isOnline } from '@/lib/device-state';
import { readNextForDevices, nextInfo } from '@/lib/next-disk';
import { listNextCardWriters } from '@/lib/nfc/store';
import { HelpTip } from '@/components/help/help-tip';
import { PageHeader } from '@/components/shell/page-header';
import { DeviceList } from '@/components/devices/device-list';
import { PairButton } from '@/components/devices/pair-button';
import { FirmwareNotice } from '@/components/devices/firmware-notice';
import { FobButton } from '@/components/nfc/fob-button';

export default async function DevicesPage() {
  const { orgId, userId } = await requireOrg();
  // One clock for the whole render, so two cards can never disagree about what
  // "now" is and flip each other across the staleness boundary.
  const now = nowMs();
  // Independent reads, so they go together rather than in series.
  // Next-card writers, not every reader: a board before 1.6.0 cannot write one.
  // The user's own skip-password preference decides whether Update asks for
  // the password; the route checks the same preference again, so this only
  // shapes the dialog.
  const [devices, releases, writers, prefs] = await Promise.all([listDevices(orgId), listReleases(orgId), listNextCardWriters(orgId), getUserPrefs(userId)]);

  const online = devices.filter((d) => isOnline(d.lastSeenAt, now)).length;

  // The same next-disk verdict the drive chips render (multi-disk plan R3),
  // computed once here and handed down by device id rather than per card.
  const nexts = await readNextForDevices(orgId, devices);
  const nextById = Object.fromEntries(
    devices.map((d) => [d.id, nextInfo(nexts.get(d.id), d.preloadSha256, d.preloadState)]),
  );

  // The card's send line (spec §4): what waits or happened lately, and whether Receive runs, per sending board.
  const [sendTargets, summaries] = await Promise.all([listSendTargets(getDb(), orgId, now), sendSummaries(getDb(), orgId, new Date(now))]);
  const sendLineById = Object.fromEntries(sendTargets.map((t) => {
    const s = summaries[t.id];
    return [t.id, cardSendLine(s, receiverRunning(t, (s?.sending ?? 0) > 0, now))];
  }));

  // Uploads from the Amiga (spec 2026-10-18 §4, §8): files stored within 24 h, or the update a Network board needs.
  const uploads = await uploadSummaries(getDb(), orgId, new Date(now));
  const uploadLineById = Object.fromEntries(devices.map((d) => [d.id,
    cardUploadLine(uploads[d.id], d.firmwareVersion, d.secondDriveReported === 'net')]));

  // The registry is indexed ONCE and shared, so "which release is newest" is
  // computed in exactly one place -- the notice and the cards cannot disagree
  // about it, and the per-device step is a map lookup rather than three walks
  // of the whole release list.
  const registry = buildRegistry(releases);
  const states = devices.map((d) => firmwareState(d.firmwareVersion, registry));
  const behind = countBehind(states);
  // True when any release a BEHIND device is missing is a security release --
  // not merely when the newest one is. A security release followed by an
  // ordinary one must not go quiet for the boards still missing the fix.
  const securityPending = states.some((s) => s.kind === 'behind' && s.securityPending);

  // Computed HERE, with the same refuseTarget the batch route rejects with, so
  // the UI can never offer a checkbox for something the server would refuse.
  // A board that cannot update gets no control at all rather than a dead one.
  const selectableIds = registry.latest
    ? devices.filter((d) => refuseTarget(d, registry.latest!, registry) === null).map((d) => d.id)
    : [];

  return (
    <>
      <PageHeader
        eyebrow="Hardware"
        title="Devices"
        help="boards"
        subtitle={`${devices.length} paired · ${online} online · long-poll every 25 s`}
        actions={<div className="flex items-center gap-2">{writers.length > 0 && <><FobButton mode="next" testId="write-next-card" title="Next-disk card" disks={[]} devices={writers} /><span style={{ color: 'var(--on-dark)' }}><HelpTip topic="nfc" /></span></>}<PairButton /></div>}
      />
      <div className="flex flex-col gap-3 px-4 pb-10 sm:px-7">
        {registry.latest && (
          <FirmwareNotice behind={behind} total={devices.length}
                          latest={registry.latest} security={securityPending} />
        )}
        {devices.length === 0 ? (
          <div className="glass-card p-6 text-[13px]" style={{ color: 'var(--muted)' }}>
            No devices paired yet. Press <strong>Pair a device</strong> and enter the code on the hardware.
          </div>
        ) : (
          <DeviceList devices={devices} now={now} states={states}
                      selectableIds={selectableIds} latest={registry.latest} nextById={nextById} sendLineById={sendLineById} uploadLineById={uploadLineById}
                      skipPassword={prefs.firmware.skipPassword} />
        )}
      </div>
    </>
  );
}
