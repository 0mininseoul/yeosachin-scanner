"""Export only typed, non-identifying fixture measurements from an isolated runner."""
import errno
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import socket
import subprocess
import sys
import time

SOURCE = 'd529a77a076ae7985c15c7f7b431809df9d75db0'
PRESET = dict(preset='13i-32q-f5', resolvers=48, slots=128, workers=32, instances=13, cpu=1, features=80, processFeatureSlots=5)
LIMITS = {'global': 7, 'secondary': 7, 'secondary:relationship': 4}
POLICY = '(version 1)(allow default)(deny network-outbound (remote ip))(deny network-bind (local ip))'
FULL = {'verified', 'completed_without_direct_order_handoff', 'published_with_ledger_issues',
        'completed_over_target', 'completed_below_coverage'}
STAGES = {'featureAnalysis','genderResolution','genderTriage','privateAccountName','partnerSafety','highRiskNarrative'}
STATES = {'failed','processing','queued','completed','reserved','started','success','succeeded','response_rejected',
          'cutoff','cancelled','settled','leased','released','recovery_required','pending','paid','preflight','apify','gemini'}
PROOF_KEYS = ('publicRows privateRows ownerWebp otherImageDenied anonymousImageDenied originalImagesMatched '
              'ownerResult otherResult anonymousResult duplicate_attempts duplicate_settlements unpriced unsettled_attempts '
              'provenUnsentCutoffs settlements modelCalls reservations cancelled open_provider_leases open_model_slots '
              'open_reservations charged_micros mismatched_settlement_costs unmatched_settlements').split()

def integer(value):
    if type(value) is not int or not 0 <= value <= 10**16:
        raise ValueError('invalid nonnegative integer')
    return value

def boolean(value):
    if type(value) is not bool:
        raise ValueError('invalid boolean')
    return value

def pick(row, numbers='', flags=''):
    return {**{k: integer(row[k]) for k in numbers.split()}, **{k: boolean(row[k]) for k in flags.split()}}

def nullable_integer(value):
    return None if value is None else integer(value)

def categorical(value, allowed):
    if not isinstance(value,str):
        raise ValueError('invalid category')
    return value if value in allowed else 'other'

def issue_counts(values):
    if not isinstance(values,list) or len(values)>256:
        raise ValueError('invalid issue list')
    return ['issue'] * len(values)

def rows(raw,key):
    data=raw[key]
    if not isinstance(data,list) or len(data)>256:
        raise ValueError('invalid aggregate rows')
    return data

def proof(row):
    result={k:integer(row[k]) for k in PROOF_KEYS}
    result['ledgerIssues']=issue_counts(row['ledgerIssues'])
    result['actorReceipts']={phase:pick(row['actorReceipts'][phase],
        'starts matched receipts duplicateStarts duplicateInputs missingReceipts unmatchedReceipts unreconciled wrongCost simulatedMicros')
        for phase in ('paid','preflight')}
    return result

def named_rows(raw,key,labels,numbers,micros=''):
    output=[]
    for row in rows(raw,key):
        item=pick(row,numbers)
        for name in labels.split():
            item[name]=categorical(row[name], STAGES if name=='stage' else STATES)
        for name in micros.split():
            value=row[name]
            if not isinstance(value,str) or not re.fullmatch('[0-9]{1,16}',value):
                raise ValueError('invalid aggregate amount')
            item[name]=str(integer(int(value)))
        output.append(item)
    return output

def project(raw):
    if raw['sourceRevision'] != SOURCE or raw['capacityPreset'] != PRESET:
        raise ValueError('source mismatch')
    status=categorical(raw['status'],FULL|{'failed'})
    if status=='other':
        raise ValueError('unknown result')
    r={'sourceRevision':SOURCE,'capacityPreset':PRESET,'status':status,**pick(raw,'owners workers publicCount renderedOwners injectedTimeouts injectedWorker429s','productionPaid observedTiming coverage99 resumedTimedOutRead'),
       'sharedLedgerIssues':issue_counts(raw['sharedLedgerIssues'])}
    limits=[]
    for row in rows(raw['apifyHeadroomEvidence'],'scopes'):
        if row['scope'] not in LIMITS:
            raise ValueError('unknown limit')
        limits.append({'scope':row['scope'],**pick(row,'sourceLimit effectiveLimit ratePerMinute peak admissions openAtStop')})
    r['apifyHeadroomEvidence']={'scopes':limits}
    if 'resolverEvidence' in raw and raw['resolverEvidence'] is not None:
        obs=raw['resolverEvidence']
        if 'coverage' in obs:
            r['resolverCoverage']=categorical(obs['coverage'],{'database_and_sdk','sdk_only'})
        counts='sdkEntries wireSends durableAttempts unboundWithoutSend budgetOnlyCancelled cutoffs'.split()
        safe={k:integer(obs[k]) for k in counts if k in obs}
        if 'unsentCancelledByOwner' in obs:
            safe['unsentCancelledByOwner']=[integer(v) for v in rows(obs,'unsentCancelledByOwner')]
        if 'events' in obs:
            safe['events']=pick(obs['events'],'wire abort waitAborted generated sdkReturned sdkRejected usageRead')
        r['resolverEvidence']=safe
    if status in FULL:
        r.update(pick(raw,'lateOwners ownersWithLedgerIssues ownersBelowCoverage duplicateCreates verifiedResultEmailClaims '
                      'publishedHandoffs publishedHandoffCalls syntheticActorStarts syntheticModelCalls','coverageBelowTarget'))
        r['times']=[pick(x,'owner startToOwnerReadyMs startToPublicationMs queueWaitMs','withinHour') for x in rows(raw,'times')]
        r['resolutionByOwner']=[pick(x,'owner eligible ready skipped cutoffs costKnown usageMissing nonterminalAttempts') for x in rows(raw,'resolutionByOwner')]
        r['proofs']=[proof(x) for x in rows(raw,'proofs')]
    else:
        r.update(pick(raw,'elapsedMs'))
        r['verifiedRequestsBeforeStop']=[proof(x) for x in rows(raw,'verifiedRequestsBeforeStop')]
        r['ownerHttpReads']=[{**pick(x,'owner images fromPaymentMs'),'fromSeatMs':nullable_integer(x['fromSeatMs'])}
                             for x in rows(raw,'ownerHttpReads')]
        r['diagnosticsUnavailable']=[categorical(v,{'pipeline_summary','resolver_ledger','unknown_budget'})
                                     for v in rows(raw,'diagnosticsUnavailable')]
        r['emailClaimsBeforeStop']=nullable_integer(raw.get('emailClaimsBeforeStop'))
        r['resolutionBeforeStop']=None
        if raw.get('resolutionBeforeStop') is not None:
            r['resolutionBeforeStop']=[pick(x,'owner eligible ready skipped cutoffs costKnown usageMissing nonterminalAttempts')
                                       for x in rows(raw,'resolutionBeforeStop')]
        r['settledUnknownBudget']=None
        if raw.get('settledUnknownBudget') is not None:
            r['settledUnknownBudget']=pick(raw['settledUnknownBudget'],'count estimatedMicros resolverCount resolverEstimatedMicros')
        if 'paymentTimingAtStop' in raw:
            r['paymentTimingAtStop']=pick(raw['paymentTimingAtStop'],'paid published readyWithinHour readyOverHour unfinishedOverHour')
        for key,labels,numbers,micros in (
            ('requests','status','n',''),('attempts','stage status','n open','estimatedMicros'),
            ('holds','state','n','estimatedMicros settledMicros'),('actors','phase status','n unreconciled','knownMicros'),
            ('leases','workload_role logical_provider state','n','')):
            if key in raw:
                r[key]=named_rows(raw,key,labels,numbers,micros)
        # Only fixed PostgreSQL classes leave the runner. Raw RPC names, exception messages and argument values do not.
        known={'53100','53200','53300','57014','55P03','40001','40P01','P0001'}
        codes={}
        for key,amount in raw['errors'].items():
            parts=key.split('.')
            code=parts[1] if len(parts)>1 and parts[1] in known else 'other'
            codes[code]=codes.get(code,0)+integer(amount)
        r['databaseErrorCounts']=codes
        if 'unfinished' in raw:
            job_stages={'track:profile-ai:batch:*','track:profiles:batch:*','track:relationships:collect',
                        'track:target-evidence:collect','track:narratives:batch:*','coordinator:finalize'}
            error_codes={'ANALYSIS_V2_AI_RESULT_RECOVERY_PENDING','ANALYSIS_V2_JOB_HANDLER_FAILED',
                         'ANALYSIS_V2_SCHEDULER_OPERATION_PERSISTENCE_ERROR','ANALYSIS_V2_AI_CAPACITY_PENDING'}
            r['unfinished']=[{**pick(v,'n oldestSeconds'),'stage':categorical(v['stage'],job_stages),
                              'status':categorical(v['status'],STATES),
                              'lastCode':None if v['lastCode'] is None else categorical(v['lastCode'],error_codes)}
                             for v in rows(raw,'unfinished')]
        reason=raw.get('reason')
        r['stopCode']=categorical(reason,{'SHARED_WORKER_track:profile-ai:batch:batch:ANALYSIS_V2_JOB_HANDLER_FAILED',
            'SHARED_OWNER_READ_HOUR_EXCEEDED','SHARED_RESOLVER_COVERAGE_BELOW_99_PERCENT','UNCLASSIFIED'})
    return r

def accepted(r,rc):
    if rc!=0 or r['status']!='verified':
        return False
    if not (r['observedTiming'] and r['productionPaid'] and r['coverage99'] and not r['coverageBelowTarget']
            and (r['owners'],r['workers'],r['publicCount'],r['renderedOwners'],r['verifiedResultEmailClaims'])==(6,32,600,6,6)
            and r['injectedTimeouts'] and r['resumedTimedOutRead'] and r['injectedWorker429s']
            and r['publishedHandoffs']==6 and not any([r['lateOwners'],r['ownersWithLedgerIssues'],r['ownersBelowCoverage'],
                r['duplicateCreates'],r['sharedLedgerIssues']])):
        return False
    limits=r['apifyHeadroomEvidence']['scopes']
    if len(limits)!=3 or {x['scope']:x['effectiveLimit'] for x in limits}!=LIMITS or not all(
            0<x['peak']<=x['effectiveLimit'] and x['openAtStop']==0 for x in limits):
        return False
    times,quality,proofs=r['times'],r['resolutionByOwner'],r['proofs']
    if not (len(proofs)==6 and [t['owner'] for t in times]==[q['owner'] for q in quality]==list(range(1,7))):
        return False
    if not all(t['withinHour'] and 0<t['startToOwnerReadyMs']<=3_600_000 for t in times):
        return False
    if not all(q['eligible']==300 and 297<=q['ready']<=300 for q in quality):
        return False
    for p in proofs:
        if not ((p['publicRows'],p['privateRows'],p['ownerWebp'],p['otherImageDenied'],p['ownerResult'],p['otherResult'],p['anonymousResult'])==(600,1,602,602,200,404,401)
                and p['originalImagesMatched']==p['anonymousImageDenied']==602 and not p['ledgerIssues']
                and p['duplicate_attempts']==p['duplicate_settlements']==p['unpriced']==0
                and p['unsettled_attempts']==p['provenUnsentCutoffs'] and p['settlements']==p['modelCalls']
                and p['reservations']==p['settlements']+p['cancelled']):
            return False
    return [p['provenUnsentCutoffs'] for p in proofs]==r['resolverEvidence']['unsentCancelledByOwner']

def network_witness():
    for command,address in [('connect',('127.0.0.1',9)),('bind',('127.0.0.1',0))]:
        try:
            with socket.socket() as sock:
                getattr(sock,command)(address)
        except OSError as error:
            if error.errno==errno.EPERM:
                continue
        return False
    return True

def free_bytes(directory):
    return shutil.disk_usage(directory).free

def run(source,private,public):
    report={'outcome':'precondition_failed','processExit':None,'rawSha256':None,'measured':None}
    host=report['host']={}
    metadata='source'
    try:
        sha=subprocess.check_output(['git','rev-parse','HEAD'],cwd=source,text=True).strip()
        node=subprocess.check_output(['node','-p','process.versions.node'],text=True).strip()
        pg=subprocess.check_output(['postgres','--version'],text=True).strip()
        if sha!=SOURCE or node!='24.13.1' or not re.fullmatch(r'postgres \(PostgreSQL\) 17\.[0-9]+(?: \(Homebrew\))?',pg):
            raise ValueError('wrong runtime')
        if platform.system()!='Darwin' or platform.machine()!='arm64' or not re.fullmatch(r'15(?:\.\d+){0,2}',platform.mac_ver()[0]):
            raise ValueError('wrong host')
        host.update(node=node,postgres=pg,macOS=platform.mac_ver()[0],architecture='arm64',diskFloorBytes=4*1024**3)
        metadata='sandbox'
        witness=subprocess.run(['/usr/bin/sandbox-exec','-p',POLICY,sys.executable,__file__,'witness'],
            stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        host['sandboxDeniedOutboundAndBind']=witness.returncode==0
        if witness.returncode!=0:
            raise ValueError('isolation failed')
        metadata='disk_before_run'
        def space():
            return min(free_bytes(private),free_bytes('/tmp'),free_bytes(source))
        host['initialFreeBytes']=host['minimumObservedFreeBytes']=space()
        if host['initialFreeBytes']<host['diskFloorBytes']:
            raise ValueError('low initial disk')
        metadata='benchmark'
        raw=private/'receipt.json'
        with (private/'benchmark.log').open('xb') as log:
            args=['node','scripts/standard-shared-capacity.mjs','6','13i-32q-f5','recovery',str(raw),
                  '600','observed','coverage99','production-paid','--apify-headroom=7']
            with subprocess.Popen(args,cwd=source,stdout=log,stderr=subprocess.STDOUT) as process:
                while process.poll() is None:
                    host['minimumObservedFreeBytes']=min(host['minimumObservedFreeBytes'],space())
                    time.sleep(3)
                report['processExit']=process.returncode
        host['finalFreeBytes']=space()
        # A crash before the JSON receipt can leave a useful disk indicator in private stderr.
        with (private/'benchmark.log').open('rb') as stream:
            report['logDiskErrorLines']=sum(bool(re.search(b'ENOSPC|no space left on device',line,re.I)) for line in stream)
        if not raw.is_file():
            report['outcome']='missing_receipt'
            return False
        metadata='receipt_projection'
        data=raw.read_bytes()
        report['rawSha256']=hashlib.sha256(data).hexdigest()
        measured=project(json.loads(data))
        report['measured']=measured
        ok=accepted(measured,report['processExit'])
        report['outcome']='verified' if ok else 'failed'
        return ok
    except (OSError,ValueError,KeyError,TypeError,subprocess.SubprocessError):
        report['outcome']='invalid_receipt' if metadata=='receipt_projection' else 'precondition_failed'
        report['errorPhase']=metadata
        return False
    finally:
        with (public/'aggregate.json').open('x') as target:
            json.dump(report,target,separators=(',',':'))

if __name__=='__main__':
    os.umask(0o077)
    if sys.argv[1:]==['witness']:
        sys.exit(0 if network_witness() else 1)
    if len(sys.argv)!=5 or sys.argv[1]!='run':
        sys.exit(2)
    sys.exit(0 if run(*(Path(p).resolve() for p in sys.argv[2:])) else 1)
