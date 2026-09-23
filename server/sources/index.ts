// server/sources/index.ts
// The receiver switch: ADSB_SOURCE picks one upstream. Everything after this point is source-agnostic.
import type { ServerConfig } from '../config.ts'
import { makeAdsbfi } from './adsbfi.ts'
import { makeAdsblol } from './adsblol.ts'
import { makeReadsb } from './readsb.ts'
import { makeReplay } from './replay.ts'
import type { Source } from './types.ts'

/** The User-Agent adsb.lol asks for: who we are and how to reach the operator. */
export function userAgent(contact: string): string {
  return `FlightHopper/0.1 (+${contact})`
}

export function makeSource(cfg: ServerConfig): Source {
  switch (cfg.source) {
    case 'adsblol':
      if (cfg.contact === null) throw new Error('makeSource: adsblol needs a contact for its User-Agent (CONTACT)')
      return makeAdsblol({ userAgent: userAgent(cfg.contact) })
    case 'adsbfi':
      return makeAdsbfi({ userAgent: cfg.contact === null ? 'FlightHopper/0.1' : userAgent(cfg.contact) })
    case 'readsb':
      if (cfg.readsbCoverage === null) throw new Error('makeSource: readsb needs a coverage circle (READSB_COVERAGE)')
      return makeReadsb({ baseUrl: cfg.readsbUrl, coverage: cfg.readsbCoverage })
    case 'replay':
      return makeReplay({ files: cfg.replayFiles, speed: cfg.replaySpeed })
  }
}
