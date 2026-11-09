/** Unit: public build boundary for the frozen local-link contract §3. Existing group
 * reference tests don't cover mutation intent/receipt fields. Minimal failure is an
 * injected actor/grant or an omitted revision silently accepted as trusted context.
 * Real public parser and existing endpoint configuration parser, no host/DB/network.
 */
import { describe, expect, it } from 'vitest';
import { parseProjectGroupLinksIntent } from '../projectGroupLinks';
const group={endpoint:' https://chat.example/Case/API/// ',roomId:'AAAAAAAA-1111-4111-8111-111111111111'};
const target={accountId:'account',deviceId:'device:opaque',projectId:'project'};
const link={action:'link',requestId:'r',group,target,expectedRevision:0};
describe('public project group link intent',()=>{
  it('normalizes endpoints without changing URL path case and accepts all three explicit actions',()=>{
    const result=parseProjectGroupLinksIntent(link);
    expect(result).toMatchObject({action:'link',expectedRevision:0,group:{endpoint:'https://chat.example/Case/API',roomId:group.roomId.toLowerCase()}});
    expect(parseProjectGroupLinksIntent({action:'list',group})).toMatchObject({limit:50,includeRemoved:false});
    expect(parseProjectGroupLinksIntent({...link,action:'unlink',relationId:'row',expectedRevision:1})).toMatchObject({action:'unlink',relationId:'row'});
  });
  it('accepts the read-only by-project query with only a project id',()=>{
    expect(parseProjectGroupLinksIntent({action:'list-project',projectId:'project'})).toEqual({action:'list-project',projectId:'project'});
    // 没有群定位、没有游标、没有动作幂等键：任何多余字段都不能混进只读查询。
    for(const extra of [{group},{cursor:'c'},{requestId:'r'},{target},{actor:'a'},{includeRemoved:true}])
      expect(parseProjectGroupLinksIntent({action:'list-project',projectId:'project',...extra})).toBeNull();
    expect(parseProjectGroupLinksIntent({action:'list-project'})).toBeNull();
    expect(parseProjectGroupLinksIntent({action:'list-project',projectId:'has space'})).toBeNull();
  });
  it.each(['actor','grant','canManage','canManageGroup','ownerVerified','title'])('rejects injected public %s',field=>{
    expect(parseProjectGroupLinksIntent({...link,[field]:true})).toBeNull();
  });
  it.each([-1,1.1,'0',null,undefined,Number.MAX_SAFE_INTEGER+1])('requires an explicit safe CAS revision %s',expectedRevision=>{
    expect(parseProjectGroupLinksIntent({...link,expectedRevision})).toBeNull();
  });
  it('rejects invalid/overlong identifiers, room UUIDs and secret-bearing endpoints',()=>{
    for(const roomId of ['not-room-uuid',group.roomId+'\n'])expect(parseProjectGroupLinksIntent({...link,group:{...group,roomId}})).toBeNull();
    for(const endpoint of ['file:///private','https://user:secret@chat.example','https://chat.example?token=secret','https://chat.example/#token'])expect(parseProjectGroupLinksIntent({...link,group:{...group,endpoint}})).toBeNull();
    expect(parseProjectGroupLinksIntent({...link,target:{...target,deviceId:'d'.repeat(501)}})).toBeNull();
    expect(parseProjectGroupLinksIntent({action:'list',group,limit:101})).toBeNull();
  });
});
