// An agent's scheduled jobs. Read-only.
import { CalendarClock } from 'lucide-react';
import * as api from '../api';
import type { HermesSchedule } from '../types';
import { formatStamp } from './format';
import { gatewayDown, useLoad } from './hooks';
import { Empty, GatewayNotice, RefreshButton } from './parts';

export function SchedulesTab({
  profile,
  onGatewayChanged,
}: {
  profile: string;
  onGatewayChanged: () => void;
}) {
  const jobs = useLoad<HermesSchedule[]>(() => api.hermesSchedules(profile), [profile]);
  return (
    <section className="settings-card sv-schedules" aria-label="Hermes schedules">
      <div className="section-label">
        <CalendarClock size={18} aria-hidden="true" />
        <h3>Schedules for {profile}</h3>
        <RefreshButton loading={jobs.loading} onClick={() => void jobs.reload()} />
      </div>
      {jobs.error &&
        (gatewayDown(jobs.error) ? (
          <GatewayNotice
            profile={profile}
            onStarted={() => {
              onGatewayChanged();
              void jobs.reload();
            }}
          />
        ) : (
          <p className="form-error" role="alert">
            {jobs.error}
          </p>
        ))}
      {jobs.loading && !jobs.data && (
        <p className="muted-copy" role="status">
          Asking Hermes for {profile}'s schedules…
        </p>
      )}
      {jobs.data?.length === 0 && (
        <Empty icon={CalendarClock} title="No scheduled jobs">
          Ask {profile} in Chat to schedule something, for example a check every morning. Schedules
          only run while its gateway is running.
        </Empty>
      )}
      {jobs.data?.map((job) => {
        const paused = job.paused === true || job.enabled === false;
        return (
          <div className="sv-schedule" key={job.job_id ?? job.name}>
            <div>
              <strong>{job.name ?? job.job_id}</strong>
              <code>{job.schedule ?? 'Unavailable'}</code>
            </div>
            <span className={`status ${paused ? 'muted' : 'good'}`}>
              <span className="status-dot" />
              {paused ? 'Paused' : 'Active'}
            </span>
            <dl>
              <div>
                <dt>Next run</dt>
                <dd>{paused ? 'Paused' : formatStamp(job.next_run_at)}</dd>
              </div>
              <div>
                <dt>Last run</dt>
                <dd>
                  {formatStamp(job.last_run_at)}
                  {job.last_status ? ` · ${job.last_status}` : ''}
                </dd>
              </div>
            </dl>
            {job.last_error && <p className="form-error">{job.last_error}</p>}
          </div>
        );
      })}
    </section>
  );
}
