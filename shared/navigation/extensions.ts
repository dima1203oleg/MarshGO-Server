import type { Coordinate, LocationFix, MatchedLocation, ProviderHealth, RouteResult, EtaEstimate } from './contracts';
export type TrafficRequest = { bounds: [Coordinate,Coordinate]; at: string };
export type TrafficFlow = { coordinates: Coordinate[]; severity: 'FREE'|'MODERATE'|'SLOW'|'HEAVY'|'SEVERE'; capturedAt: string };
export type TrafficIncident = { id:string; coordinate:Coordinate; label:string; capturedAt:string };
export type TrafficSnapshot = { flows:TrafficFlow[]; incidents:TrafficIncident[]; expiresAt:string; available:boolean };
export interface TrafficProvider { readonly id:string; getFlow(request:TrafficRequest):Promise<TrafficFlow[]>; getIncidents(request:TrafficRequest):Promise<TrafficIncident[]>; health():Promise<ProviderHealth> }
export interface MapMatchingProvider { match(fixes:LocationFix[],context:{route:RouteResult}):Promise<{location:MatchedLocation;confidence:number;provider:string}> }
export interface VoiceProvider { speak(instruction:{text:string;language:string}):Promise<void>; stop():void; setMuted(muted:boolean):void }
export class NoVoiceProvider implements VoiceProvider { async speak() {} stop() {} setMuted() {} }
export interface HapticsProvider { signal(kind:'MANEUVER'|'WARNING'):Promise<void> }
export interface PushProvider { requestPermission():Promise<'GRANTED'|'DENIED'|'UNSUPPORTED'>; subscribe():Promise<void> }
export interface SecureStorageProvider { get(key:string):Promise<string|null>; set(key:string,value:string):Promise<void>; remove(key:string):Promise<void> }
export interface BackgroundLocationProvider { supported:boolean; start(mode:'RENDEZVOUS'|'ACTIVE_JOURNEY'|'DRIVER_NAVIGATION'):Promise<void>; stop():Promise<void> }
export class UnsupportedBackgroundLocationProvider implements BackgroundLocationProvider { supported=false; async start():Promise<void> { throw new Error('GPS_UNAVAILABLE'); } async stop() {} }
export interface ETAEnhancer { estimate(route:RouteResult,remainingMeters:number,at:string):EtaEstimate }
export interface GeocodingProvider { search(query:string,context?:{near:Coordinate}):Promise<Array<{id:string;label:string;coordinate:Coordinate}>>; reverse(coordinate:Coordinate):Promise<{id:string;label:string;coordinate:Coordinate}> }
