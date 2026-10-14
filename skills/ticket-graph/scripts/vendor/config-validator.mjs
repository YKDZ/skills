/*
 * 由 ajv@8.20.0 与 esbuild@0.28.2 根据 skills/ticket-graph/ticket-graph.schema.json 生成。
 * 请勿手动修改此文件。重新构建：pnpm run build:ticket-graph-config
 * 来源与维护说明：config-validator.SOURCE.json
 *
 * The MIT License (MIT)
 *
 * Copyright (c) 2015-2021 Evgeny Poberezkin
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
var d=l,f=l;var c=new RegExp("\\S","u");function l(p,{instancePath:i="",parentData:u,parentDataProperty:y,rootData:h=p}={}){let e=null,r=0;if(p&&typeof p=="object"&&!Array.isArray(p)){if(p.tickets===void 0){let t={instancePath:i,schemaPath:"#/required",keyword:"required",params:{missingProperty:"tickets"},message:"must have required property 'tickets'"};e===null?e=[t]:e.push(t),r++}if(p.completion===void 0){let t={instancePath:i,schemaPath:"#/required",keyword:"required",params:{missingProperty:"completion"},message:"must have required property 'completion'"};e===null?e=[t]:e.push(t),r++}for(let t in p)if(!(t==="$schema"||t==="tickets"||t==="completion")){let s={instancePath:i,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty:t},message:"must NOT have additional properties"};e===null?e=[s]:e.push(s),r++}if(p.$schema!==void 0&&typeof p.$schema!="string"){let t={instancePath:i+"/$schema",schemaPath:"#/properties/%24schema/type",keyword:"type",params:{type:"string"},message:"must be string"};e===null?e=[t]:e.push(t),r++}if(p.tickets!==void 0){let t=p.tickets;if(typeof t=="string"){if(!c.test(t)){let s={instancePath:i+"/tickets",schemaPath:"#/properties/tickets/pattern",keyword:"pattern",params:{pattern:"\\S"},message:'must match pattern "\\S"'};e===null?e=[s]:e.push(s),r++}}else{let s={instancePath:i+"/tickets",schemaPath:"#/properties/tickets/type",keyword:"type",params:{type:"string"},message:"must be string"};e===null?e=[s]:e.push(s),r++}}if(p.completion!==void 0){let t=p.completion;if(t&&typeof t=="object"&&!Array.isArray(t)){if(t.values===void 0){let s={instancePath:i+"/completion",schemaPath:"#/properties/completion/required",keyword:"required",params:{missingProperty:"values"},message:"must have required property 'values'"};e===null?e=[s]:e.push(s),r++}for(let s in t)if(s!=="values"){let a={instancePath:i+"/completion",schemaPath:"#/properties/completion/additionalProperties",keyword:"additionalProperties",params:{additionalProperty:s},message:"must NOT have additional properties"};e===null?e=[a]:e.push(a),r++}if(t.values!==void 0){let s=t.values;if(Array.isArray(s)){if(s.length<1){let o={instancePath:i+"/completion/values",schemaPath:"#/properties/completion/properties/values/minItems",keyword:"minItems",params:{limit:1},message:"must NOT have fewer than 1 items"};e===null?e=[o]:e.push(o),r++}let a=s.length;for(let o=0;o<a;o++){let m=s[o];if(typeof m=="string"){if(!c.test(m)){let n={instancePath:i+"/completion/values/"+o,schemaPath:"#/properties/completion/properties/values/items/pattern",keyword:"pattern",params:{pattern:"\\S"},message:'must match pattern "\\S"'};e===null?e=[n]:e.push(n),r++}}else{let n={instancePath:i+"/completion/values/"+o,schemaPath:"#/properties/completion/properties/values/items/type",keyword:"type",params:{type:"string"},message:"must be string"};e===null?e=[n]:e.push(n),r++}}}else{let a={instancePath:i+"/completion/values",schemaPath:"#/properties/completion/properties/values/type",keyword:"type",params:{type:"array"},message:"must be array"};e===null?e=[a]:e.push(a),r++}}}else{let s={instancePath:i+"/completion",schemaPath:"#/properties/completion/type",keyword:"type",params:{type:"object"},message:"must be object"};e===null?e=[s]:e.push(s),r++}}}else{let t={instancePath:i,schemaPath:"#/type",keyword:"type",params:{type:"object"},message:"must be object"};e===null?e=[t]:e.push(t),r++}return l.errors=e,r===0}export{f as default,d as validate};
