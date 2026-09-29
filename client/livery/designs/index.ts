// client/livery/designs/index.ts
// The airline designs drawn with the kit, by livery code (liveries.json codes; aliases reach them too). A code here
// wins over the colours-only table entry of the same code.
import type { Design } from '../kit.ts'
import { ELY } from './ELY.ts'
import { FDB } from './FDB.ts'
import { ISR } from './ISR.ts'
import { RJA } from './RJA.ts'
import { WZZ } from './WZZ.ts'

export const DESIGNS: Record<string, Design> = { ELY, FDB, ISR, RJA, WZZ }
