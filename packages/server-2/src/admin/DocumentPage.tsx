import { AppShell } from './ui/AppShell';
import type { AppRow } from '../db/apps';
import type { LabelledVersionRow } from '../db/documents';
import {
  decodeData,
  mergeRecords,
  parseClock,
  recordFields,
  type DecodedData,
  type DecodedRecord,
  type FieldValue,
} from './decode';
import { formatBytes, formatClock, formatCount } from './format';

export type DocumentPageProps = {
  app: AppRow;
  collection: string;
  id: string;
  versions: LabelledVersionRow[];
};

export function DocumentPage({ app, collection, id, versions }: DocumentPageProps) {
  const decoded = versions.map((version) => ({ version, data: decodeData(version.data) }));
  const records = decoded.flatMap(({ data }) => (data.kind === 'record' ? [data.record] : []));
  const merged = mergeRecords(records);
  return (
    <AppShell
      app={app}
      tab='documents'
      trail={[
        {
          label: collection,
          href: `/admin/apps/${app.id}/documents/${encodeURIComponent(collection)}`,
        },
        { label: id },
      ]}
    >
      {merged ? (
        <div class='card'>
          <div class='card-head'>
            <div>
              <h2>Current value</h2>
              <p>
                {merged.mode === 'document'
                  ? `Newest of ${formatCount(records.length)} versions, written ${formatClock(merged.clock!)}`
                  : `Each field takes the newest write across ${formatCount(records.length)} versions`}{' '}
                · schema v{merged.schemaVersion}
              </p>
            </div>
          </div>
          <FieldsTable fields={merged.fields} showClocks={merged.mode === 'field'} />
        </div>
      ) : null}
      {decoded.map(({ version, data }) => (
        <VersionCard version={version} data={data} />
      ))}
    </AppShell>
  );
}

function writerName(version: LabelledVersionRow): string {
  if (version.label === null) return 'Revoked token';
  return version.username ? `${version.username} · ${version.label}` : version.label;
}

function VersionCard({ version, data }: { version: LabelledVersionRow; data: DecodedData }) {
  const sizeBytes = new TextEncoder().encode(version.data).byteLength;
  return (
    <div class='card'>
      <div class='card-head'>
        <div>
          <h2 title={version.writer_id}>{writerName(version)}</h2>
          <p>
            Written {formatClock(version.hlc)} · seq {version.seq} · {formatBytes(sizeBytes)}
            {data.kind === 'record' ? ` · schema v${data.record.schemaVersion}` : null}
          </p>
        </div>
      </div>
      <VersionBody data={data} />
      <details class='raw'>
        <summary>Raw data</summary>
        <pre>
          {data.kind === 'record' || data.kind === 'json'
            ? prettyJson(JSON.parse(version.data))
            : version.data}
        </pre>
      </details>
    </div>
  );
}

function VersionBody({ data }: { data: DecodedData }) {
  switch (data.kind) {
    case 'record':
      return <RecordBody record={data.record} />;
    case 'encrypted':
      return (
        <p class='card-note'>Encrypted on the device, so only its contents' size is visible.</p>
      );
    case 'json':
      return <p class='card-note'>This data is JSON but not in the Pact client's record format.</p>;
    case 'opaque':
      return <p class='card-note'>This data isn't JSON, so it's shown as written.</p>;
  }
}

function RecordBody({ record }: { record: DecodedRecord }) {
  const fields =
    record.clock !== undefined
      ? recordFields({ ...record, clocks: undefined })
      : recordFields(record);
  return (
    <>
      <FieldsTable fields={fields} showClocks={record.clock === undefined} />
      {record.text !== undefined ? (
        <p class='card-note'>
          Text fields are stored as Yjs state (
          {formatBytes(Math.floor((record.text.length * 3) / 4))}) and aren't decoded here.
        </p>
      ) : null}
    </>
  );
}

function FieldsTable({ fields, showClocks }: { fields: FieldValue[]; showClocks: boolean }) {
  return (
    <div class='table-scroll'>
      <table>
        <thead>
          <tr>
            <th>Field</th>
            <th>Value</th>
            {showClocks ? <th>Written</th> : null}
          </tr>
        </thead>
        <tbody>
          {fields.map((field) => (
            <tr>
              <td class='mono strong'>{field.name}</td>
              <td class='value'>
                {field.value === undefined ? (
                  <span class='muted'>Unset</span>
                ) : (
                  <code>{prettyJson(field.value)}</code>
                )}
              </td>
              {showClocks ? (
                <td class='muted' title={field.clock}>
                  {field.clock ? <ClockCell raw={field.clock} /> : '—'}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ClockCell({ raw }: { raw: string }) {
  const clock = parseClock(raw);
  if (!clock) return <span class='mono'>{raw}</span>;
  return (
    <>
      {formatClock(raw)} <span class='mono small'>{clock.node}</span>
    </>
  );
}

function prettyJson(value: unknown): string {
  return typeof value === 'object' && value !== null
    ? JSON.stringify(value, null, 2)
    : JSON.stringify(value);
}
