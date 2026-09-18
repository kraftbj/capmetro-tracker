import json, csv, collections, datetime, sys, os
FX='tests/fixtures/feeds-20260819/'; G='/tmp/gtfs/'
WINDOW_BEFORE_S, WINDOW_AFTER_S = 900, 2700          # now-15min .. now+45min
PREDICTION_GRACE_S = 90                              # how far past a prediction may still show
ROUTE='4'
def rd(p): return csv.DictReader(open(G+p, encoding='utf-8-sig'))
stops={s['stop_id']:s for s in rd('stops.txt')}
routes={r['route_id']:r for r in rd('routes.txt')}
trips={t['trip_id']:t for t in rd('trips.txt')}
rtrips={k:v for k,v in trips.items() if v['route_id']==ROUTE}
seq=collections.defaultdict(list); tpflag=collections.defaultdict(set)
with open(G+'stop_times.txt', encoding='utf-8-sig') as f:
    for r in csv.DictReader(f):
        if r['trip_id'] in rtrips:
            seq[r['trip_id']].append((int(r['stop_sequence']), r['stop_id'], r['arrival_time']))
            if r.get('timepoint')=='1': tpflag[r['trip_id']].add(r['stop_id'])
for k in seq: seq[k].sort()

vp=json.load(open(FX+'vehiclepositions.json')); tu=json.load(open(FX+'tripupdates.json')); al=json.load(open(FX+'servicealerts.json'))
NOW=int(vp['header']['timestamp'])
CT=datetime.timezone(datetime.timedelta(hours=-5))
now_dt=datetime.datetime.fromtimestamp(NOW,CT)
noon=now_dt.replace(hour=12,minute=0,second=0,microsecond=0)
svc_mid=int((noon-datetime.timedelta(hours=12)).timestamp())   # DST-correct per contract
def clock2epoch(c):
    h,m,s=[int(x) for x in c.split(':')]; return svc_mid+h*3600+m*60+s

tuidx={}
for e in tu['entity']:
    t=e.get('tripUpdate')
    if t: tuidx[t['trip']['tripId']]=t

# realtime SKIPPED
skipped=collections.defaultdict(int)
for t in tuidx.values():
    for s in t.get('stopTimeUpdate',[]):
        if s.get('scheduleRelationship')=='SKIPPED': skipped[s.get('stopId')]+=1
# alerts
def ep(iso):
    if not iso: return None
    return int(datetime.datetime.fromisoformat(iso.replace('Z','+00:00')).timestamp())
ALERT_ALLOW=['id','effect','cause','headerText','descriptionText','url','activePeriods','informedEntities']
alerts=[]; closed=set()
for a in al:
    per=(a.get('activePeriods') or [{}])[0]
    fr,un=ep(per.get('start')), ep(per.get('end'))
    if fr and fr>NOW: continue
    if un and un<NOW: continue
    ies=a.get('informedEntities') or []
    if not any(ie.get('routeId')==ROUTE for ie in ies): continue
    sids=list(dict.fromkeys(ie['stopId'] for ie in ies if ie.get('stopId')))   # set semantics: no duplicates
    eff=a.get('effect') if a.get('effect') in ("NO_SERVICE","DETOUR","REDUCED_SERVICE","MODIFIED_SERVICE") else "OTHER"
    if eff=='NO_SERVICE': closed.update(sids)
    alerts.append({"id":a['id'],"effect":eff,"cause":a.get('cause') or "UNKNOWN_CAUSE",
      "header":a.get('headerText') or "","description":a.get('descriptionText') or "",
      "url":a.get('url'),"active_from":fr or 0,"active_until":un,"stop_ids":sids,
      "severity":"high" if eff=="NO_SERVICE" else ("medium" if eff in ("DETOUR","REDUCED_SERVICE") else "low")})

# patterns
pat=collections.defaultdict(list)
for tid,rows in seq.items(): pat[tuple(s for _,s,_ in rows)].append(tid)
bydir=collections.defaultdict(list)
for sig,tl in pat.items(): bydir[rtrips[tl[0]]['direction_id']].append((sig,tl))
baseline={d:max(v,key=lambda kv:len(kv[1]))[0] for d,v in bydir.items()}
def shorten(n):
    import re
    n=re.sub(r'\s*\([^)]*\)\s*$','',n).strip()
    n=re.sub(r'^\d+\s+','',n)
    for a,b in [('Northbound','NB'),('Southbound','SB'),('Eastbound','EB'),('Westbound','WB')]: n=n.replace(a,b)
    n=re.sub(r'(?<=[0-9])(St|Nd|Rd|Th)\b', lambda m: m.group(1).lower(), n)   # 8Th/Lavaca -> 8th/Lavaca
    if len(n)>24:
        cut=n[:24].rsplit(' ',1)[0]; n=(cut if cut else n[:23])+'…'
    return n
def sref(sid): return {"stop_id":sid,"stop_name":shorten(stops[sid]['stop_name'])}

# blocks
blocks=collections.defaultdict(list)
for tid,t in rtrips.items():
    if seq.get(tid): blocks[t['block_id']].append((seq[tid][0][2], tid))
for b in blocks: blocks[b].sort()

def glyph(st): return {"early":"left-triangle","ontime":"circle","late":"up-triangle",
                       "very_late":"square","unknown":"question","deadhead":"ring"}[st]

vehicles=[]
for e in vp['entity']:
    v=e.get('vehicle')
    if not v: continue
    tr=v.get('trip')
    if not tr or tr.get('routeId')!=ROUTE: continue
    tid=tr['tripId']; pos=v['position']
    veh={"vehicle_id":v['vehicle']['id'],"label":v['vehicle'].get('label'),
      "position":{"lat":pos['latitude'],"lon":pos['longitude'],
                  "bearing":pos.get('bearing'),"speed_mps":pos.get('speed')},
      "position_at":int(v['timestamp']),"in_service":True,"route_id":ROUTE,"route_short_name":routes[ROUTE]["route_short_name"]}
    veh["trip"]={"trip_id":tid,"start_time":tr['startTime'],"start_epoch":clock2epoch(tr['startTime']),
      "direction_id":int(tr['directionId']),"headsign":rtrips.get(tid,{}).get('trip_headsign'),
      "schedule_relationship":tr.get('scheduleRelationship','SCHEDULED')}
    up=tuidx.get(tid)
    veh["progress"]={"current_stop_sequence":v.get('currentStopSequence'),
      "current_stop_id":v.get('stopId'),"current_status":v.get('currentStatus')}
    # predictions: every usable stop prediction still ahead of the bus, bounded by the
    # same 45-minute forward window section 3.2 uses. Same filter as the adherence anchor:
    # sequence at or ahead of the bus, no SKIPPED, no timeless row, arrival beats departure.
    preds=[]
    cur_seq=v.get('currentStopSequence')
    canceled = tr.get('scheduleRelationship')=='CANCELED' or \
        (up or {}).get('trip',{}).get('scheduleRelationship')=='CANCELED'
    if up and cur_seq is not None and not canceled:
        for s_ in up.get('stopTimeUpdate',[]):
            sq=s_.get('stopSequence')
            if sq is None or int(sq)<int(cur_seq): continue
            if s_.get('scheduleRelationship')=='SKIPPED': continue
            t_=(s_.get('arrival') or {}).get('time') or (s_.get('departure') or {}).get('time')
            sid=s_.get('stopId')
            if not t_ or not sid: continue
            # bounded both ways: a stop the bus has already passed keeps its
            # original time and would sort to the top of a rider's panel as "due"
            if int(t_)>NOW+WINDOW_AFTER_S or int(t_)<NOW-PREDICTION_GRACE_S: continue
            preds.append([int(sq),str(sid),int(t_)])
    preds.sort(key=lambda r:r[0])
    veh["predictions"]=preds
    # adherence
    st,secs,against,reason=None,None,None,None
    if tr.get('scheduleRelationship')=='CANCELED': st,reason="unknown","trip_canceled"
    elif not up: st,reason="unknown","no_trip_update"
    elif not up.get('stopTimeUpdate'): st,reason="unknown","no_stop_predictions"
    elif tid not in seq: st,reason="unknown","trip_not_in_schedule"
    else:
        sched={sq:(sid,at) for sq,sid,at in seq[tid]}
        cur=v.get('currentStopSequence') or 0
        for s in up['stopTimeUpdate']:
            sq=s.get('stopSequence')
            if sq is None or sq<cur: continue
            if s.get('scheduleRelationship')=='SKIPPED': continue
            tm=(s.get('arrival') or s.get('departure') or {}).get('time')
            if not tm or sq not in sched: continue
            sid,at=sched[sq]; sa=clock2epoch(at); secs=int(tm)-sa
            against={"stop_id":sid,"stop_name":shorten(stops[sid]['stop_name']),"stop_sequence":sq,
                     "scheduled_at":sa,"predicted_at":int(tm)}
            st = "early" if secs<-60 else "ontime" if secs<=150 else "late" if secs<=360 else "very_late"
            break
        if st is None: st,reason="unknown","no_stop_predictions"
    if st=="unknown": secs,against=None,None
    veh["adherence"]={"state":st,"seconds":secs,"glyph":glyph(st),"against":against,"reason":reason}
    # pattern
    sig=tuple(s for _,s,_ in seq.get(tid,[]))
    base=set(baseline.get(rtrips[tid]['direction_id'],()))
    n=len(pat.get(sig,[]))
    veh["pattern"]={"is_baseline":set(sig)==base,"is_special":n<=4,"trips_in_pattern":max(n,1),
      "adds":[sref(s) for s in sig if s not in base],
      "skips":[sref(s) for s in baseline.get(rtrips[tid]['direction_id'],()) if s not in set(sig)]}
    # block
    bid=rtrips[tid]['block_id']; chain=blocks.get(bid,[]); nxt=None; conf="low"
    cur_start=seq[tid][0][2] if seq.get(tid) else None
    later=[(s,x) for s,x in chain if cur_start and s>cur_start]
    if later:
        s,x=later[0]
        gap=clock2epoch(s)-clock2epoch(seq[tid][-1][2])
        conf = "high" if 60<=gap<=1800 and seq[x][0][1]==seq[tid][-1][1] else "low"
        nxt={"trip_id":x,"direction_id":int(rtrips[x]['direction_id']),"start_time":s,
             "start_epoch":clock2epoch(s),"start_stop_id":seq[x][0][1],
             "start_stop_name":shorten(stops[seq[x][0][1]]['stop_name']),
             "is_direction_flip":rtrips[x]['direction_id']!=rtrips[tid]['direction_id']}
    else: conf="high"
    veh["block"]={"block_id":bid,"confidence":conf,"next_trip":nxt}
    vehicles.append(veh)

# add one synthetic deadhead from a real tripless vehicle
for e in vp['entity']:
    v=e.get('vehicle')
    if v and not v.get('trip'):
        p=v['position']
        vehicles.append({"vehicle_id":v['vehicle']['id'],"label":v['vehicle'].get('label'),
          "position":{"lat":p['latitude'],"lon":p['longitude'],"bearing":p.get('bearing'),"speed_mps":p.get('speed')},
          "position_at":int(v['timestamp']),"in_service":False,"route_id":ROUTE,"route_short_name":routes[ROUTE]["route_short_name"],
          "adherence":{"state":"deadhead","seconds":None,"glyph":"ring","against":None,"reason":None}})
        break

# timepoints for BOTH directions (contract 1: one flat array, each carrying its own direction_id)
def status_for(sid):
    return {"served": sid not in closed and sid not in skipped,
            "source": ("realtime_skipped" if sid in skipped else "alert_no_service" if sid in closed else None),
            "detail": (f"Skipped on {skipped[sid]} trips today" if sid in skipped
                       else "Stop closed by service alert" if sid in closed else None)}

def baseline_trip(DIR):
    btl=sorted(t for t in rtrips
               if rtrips[t]['direction_id']==DIR and tuple(x for _,x,_ in seq.get(t,()))==baseline.get(DIR))
    return btl[0] if btl else None

timepoints=[]; tp_cols={}
for DIR in ('0','1'):
    bt=baseline_trip(DIR)
    tp_cols[DIR]=[]
    if bt is None: continue
    tps=tpflag[bt]; rows=seq[bt]
    tp_idx=[i for i,(_,x,_) in enumerate(rows) if x in tps]
    tp_cols[DIR]=[rows[i][1] for i in tp_idx]
    for j,i in enumerate(tp_idx):
        sq,sid,_=rows[i]
        nxt_i = tp_idx[j+1] if j+1<len(tp_idx) else len(rows)
        minor=[]
        for k in range(i+1, nxt_i):
            msq,msid,_=rows[k]
            minor.append({"stop_id":msid,"stop_name":shorten(stops[msid]['stop_name']),
              "stop_sequence":msq,"lat":float(stops[msid]['stop_lat']),"lon":float(stops[msid]['stop_lon']),
              "service_status":status_for(msid)})
        timepoints.append({"stop_id":sid,"stop_name":shorten(stops[sid]['stop_name']),
          "stop_name_full":stops[sid]['stop_name'],"stop_sequence":sq,"direction_id":int(DIR),
          "lat":float(stops[sid]['stop_lat']),"lon":float(stops[sid]['stop_lon']),
          "service_status":status_for(sid),"minor_stops":minor})

cd=collections.defaultdict(set)
for r in csv.DictReader(open(G+'calendar_dates.txt', encoding='utf-8-sig')): cd[r['service_id']].add(r['date'])
today='20260819'
active=sorted({rtrips[t]['service_id'] for t in rtrips if today in cd.get(rtrips[t]['service_id'],())})
oldest=NOW-min(NOW,int(tu['entity'][0]['tripUpdate']['timestamp']))

# ---- next_departure (contract 1) ----------------------------------------------------------
# Earliest scheduled trip START on this route, current service date, strictly after
# generated_at, across BOTH directions. Trips the live feed reports CANCELED are excluded.
canceled_trips={tid for tid,t in tuidx.items() if (t.get('trip') or {}).get('scheduleRelationship')=='CANCELED'}
def trip_start(tid): return clock2epoch(seq[tid][0][2])
def trip_end(tid):   return clock2epoch(seq[tid][-1][2])
today_trips=[t for t in rtrips if seq.get(t) and rtrips[t]['service_id'] in active]
cands=sorted((trip_start(t), int(rtrips[t]['direction_id']), t)
             for t in today_trips if trip_start(t)>NOW and t not in canceled_trips)
next_departure=None
if cands:
    sa,dirn,t=cands[0]; sid=seq[t][0][1]
    next_departure={"scheduled_at":sa,"stop_id":sid,
      "stop_name":shorten(stops[sid]['stop_name']),"direction_id":dirn,
      "headsign":rtrips[t].get('trip_headsign')}

# ---- windowed timepoint schedule (contract 3.2) --------------------------------------------
# Scheduled arrival at every TIMEPOINT, for every trip whose span overlaps the schedule window.
w_from, w_until = NOW-WINDOW_BEFORE_S, NOW+WINDOW_AFTER_S
sched_dirs=[]
for DIR in ('0','1'):
    cols=tp_cols.get(DIR,[])
    trips_out=[]
    if cols:
        for t in today_trips:
            if rtrips[t]['direction_id']!=DIR: continue
            if trip_start(t)>w_until or trip_end(t)<w_from: continue
            at={sid:clock2epoch(a) for _,sid,a in seq[t]}
            base=trip_start(t)
            offs=[(at[c]-base) if c in at else None for c in cols]
            if all(o is None for o in offs): continue
            trips_out.append([t, base, offs])
        trips_out.sort(key=lambda r:(r[1], r[0]))
    sched_dirs.append({"direction_id":int(DIR),"timepoint_stop_ids":cols,"trips":trips_out})
schedule={"window":{"from":w_from,"until":w_until,
                    "before_s":WINDOW_BEFORE_S,"after_s":WINDOW_AFTER_S},
          "directions":sched_dirs}

doc={"schema":1,"generated_at":NOW,
 "route":{"id":ROUTE,"short_name":routes[ROUTE]['route_short_name'],"long_name":routes[ROUTE]['route_long_name'],
   "directions":[{"id":0,"headsign":"4 Mopac WB"},{"id":1,"headsign":"4 Shady EB"}],
   "next_departure":next_departure},
 "feeds":{"positions_at":NOW,"trip_updates_at":int(tu['entity'][0]['tripUpdate']['timestamp']),
   "alerts_at":NOW-100,"gtfs_feed_version":"260818_1456","gtfs_built_at":NOW-52000},
 # schedule_state: this capture ran on the feed that was current at the time, so neither
 # expired (past feed_end_date) nor superseded (a newer feed_version published upstream).
 "staleness":{"level":"fresh","oldest_feed_age_s":max(oldest,0),"schedule_age_days":1,
   "schedule_state":"current","suppress_adherence":False,"reason":None},
 "service_day":{"date":today,"service_ids":active,
   "is_exception_day":any(len(cd[s])==1 for s in active)},
 "vehicles":vehicles,"timepoints":timepoints,"schedule":schedule,"alerts":alerts}
OUT=os.environ.get('OUT','tests/fixtures/golden/route-4-20260819.json')
json.dump(doc, open(OUT,'w'), indent=1)
print(f"generated {OUT}  vehicles={len(vehicles)} timepoints={len(timepoints)} alerts={len(alerts)}")
print("timepoints per direction:", dict(collections.Counter(t['direction_id'] for t in timepoints)))
print("schedule window:", w_from, "..", w_until,
      "trips:", {d['direction_id']: len(d['trips']) for d in schedule['directions']},
      "columns:", {d['direction_id']: len(d['timepoint_stop_ids']) for d in schedule['directions']})
print("next_departure:", next_departure)
print("duplicate stop_ids in alerts:", any(len(a['stop_ids'])!=len(set(a['stop_ids'])) for a in alerts))
print("adherence states:", dict(collections.Counter(v['adherence']['state'] for v in vehicles)))
print("reasons:", dict(collections.Counter(v['adherence'].get('reason') for v in vehicles)))
