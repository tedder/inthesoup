import { AirportGroup, timelineLayout, formatTick, formatPeriod } from '../lib/forecastGroups';

function ceilingColor(ceiling: number | null) {
  if (ceiling == null) return 'bg-slate-400 dark:bg-slate-500';
  if (ceiling < 500) return 'bg-red-500';
  if (ceiling < 1000) return 'bg-amber-500';
  return 'bg-emerald-500';
}

/** Gantt-style overview: one row per airport, bars where IMC approaches are forecast. Rows link to each airport's table. */
export default function Timeline({ groups, source, localTime }: { groups: AirportGroup[]; source: string; localTime: boolean }) {
  const layout = timelineLayout(groups, source, Date.now(), localTime ? -new Date().getTimezoneOffset() : 0);
  if (!layout) return null;

  return (
    <nav id="timeline" aria-label="Approach timeline" className="card mb-6 p-4 sm:p-6 scroll-mt-8">
      <div className="flex items-baseline justify-between gap-4 mb-3">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Approach timeline</h2>
        <p className="text-xs text-slate-500 dark:text-slate-400">Bar color is the ceiling; lighter background is daytime. Select an airport to jump to it.</p>
      </div>
      <div className="flex text-xs text-slate-500 dark:text-slate-400">
        <div className="w-24 sm:w-32 shrink-0" />
        <div className="relative h-5 flex-1">
          {layout.ticks.map(tick => (
            <span key={tick.at} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${tick.left}%` }}>
              {formatTick(tick.at, localTime)}
            </span>
          ))}
        </div>
      </div>
      <ul className="space-y-0.5">
        {layout.rows.map(({ airport, bars }) => (
          <li key={airport.icao}>
            <a href={`#airport-${airport.icao}`}
              className="group flex items-center rounded hover:bg-slate-100 dark:hover:bg-slate-700/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500">
              <span className="w-24 sm:w-32 shrink-0 truncate pr-2 text-xs">
                <span className="font-semibold text-slate-900 dark:text-white group-hover:text-sky-600 dark:group-hover:text-sky-400">{airport.icao}</span>
                <span className="ml-1.5 text-slate-500 dark:text-slate-400">{Math.round(airport.distance)} nm</span>
              </span>
              <span className="relative h-4 flex-1 rounded-sm bg-slate-200 dark:bg-slate-900/60">
                {layout.sun?.day.map(({ left, width, fadeIn, fadeOut }) => {
                  // Fade the light band in after sunrise and out before sunset (percent of the band).
                  const fade = Math.min((layout.sun!.twilight / width) * 100, 50)
                  const mask = `linear-gradient(to right, ${fadeIn ? 'transparent' : 'black'}, black ${fadeIn ? fade : 0}%, black ${fadeOut ? 100 - fade : 100}%, ${fadeOut ? 'transparent' : 'black'})`
                  return (
                    <span key={left} aria-hidden="true" className="absolute inset-y-0 bg-slate-50 dark:bg-slate-600/40"
                      style={{ left: `${left}%`, width: `${width}%`, WebkitMaskImage: mask, maskImage: mask }} />
                  )
                })}
                {layout.ticks.map(tick => (
                  <span key={tick.at} aria-hidden="true" className="absolute inset-y-0 w-px bg-slate-200 dark:bg-slate-600" style={{ left: `${tick.left}%` }} />
                ))}
                {layout.sun?.edges.map(({ left, kind }) => (
                  <span key={left} aria-hidden="true" title={kind} className="absolute inset-y-0 border-l border-dotted border-slate-500 dark:border-slate-400" style={{ left: `${left}%` }} />
                ))}
                {bars.map(({ left, width, period }) => {
                  const label = formatPeriod(period.start, period.end, localTime);
                  const ceiling = period.ceiling == null ? 'ceiling N/A' : `ceiling ${period.ceiling.toLocaleString()} ft`;
                  return (
                    <span key={period.start} aria-label={`${airport.icao} ${label.date} ${label.time}, ${ceiling}`}
                      className={`group/bar absolute inset-y-0.5 rounded-sm ${ceilingColor(period.ceiling)}`}
                      style={{ left: `${left}%`, width: `max(${width}%, 3px)` }}>
                      <span role="tooltip" className="pointer-events-none invisible group-hover/bar:visible absolute bottom-full left-1/2 z-20 mb-1 -translate-x-1/2 whitespace-nowrap rounded bg-slate-900 px-2 py-1 text-xs font-medium text-white shadow-lg dark:bg-slate-100 dark:text-slate-900">
                        {ceiling}<span className="font-normal opacity-75"> · {label.time}</span>
                      </span>
                    </span>
                  );
                })}
                {layout.now != null && (
                  <span aria-hidden="true" title="Now" className="absolute -inset-y-0.5 w-0.5 bg-sky-500" style={{ left: `${layout.now}%` }} />
                )}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
