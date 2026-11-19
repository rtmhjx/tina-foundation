/** Extract only provider-returned reasoning. No inference or generated rationale. */
export function extractReasoning(item) {
  const texts=[];
  const visit=(value,inside=false)=>{
    if(typeof value==='string'){if(inside&&value)texts.push(value);return;}
    if(Array.isArray(value)){for(const part of value)visit(part,inside);return;}
    if(!value||typeof value!=='object')return;
    const reasoning=inside||['reasoning','reasoning_text','summary_text','thinking'].includes(value.type);
    if(reasoning&&typeof value.text==='string')texts.push(value.text);
    for(const key of ['reasoning','thinking','reasoning_text','summary'])if(value[key]!==undefined)visit(value[key],true);
    if(value.content!==undefined)visit(value.content,reasoning);
    // Complete Responses envelopes and native ContextRecords are also valid
    // intake shapes. Never treat an ordinary assistant message as reasoning.
    for(const key of ['output','item','response'])if(value[key]&&typeof value[key]==='object')visit(value[key],reasoning);
  };
  visit(item);return texts.join('\n');
}
export function createCotRecall({enabled=false}={}) {
  return {enabled,capture:item=>enabled?extractReasoning(item):''};
}
