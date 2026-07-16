/**
 * Porter stemmer (M.F. Porter, 1980) — classic algorithm, no dependencies.
 * Used by both the BM25 index build and query tokenisation so that
 * "provisioning" and "provision" reduce to the same term.
 */

const step2list: Record<string, string> = {
  ational: 'ate', tional: 'tion', enci: 'ence', anci: 'ance', izer: 'ize',
  bli: 'ble', alli: 'al', entli: 'ent', eli: 'e', ousli: 'ous', ization: 'ize',
  ation: 'ate', ator: 'ate', alism: 'al', iveness: 'ive', fulness: 'ful',
  ousness: 'ous', aliti: 'al', iviti: 'ive', biliti: 'ble', logi: 'log',
};

const step3list: Record<string, string> = {
  icate: 'ic', ative: '', alize: 'al', iciti: 'ic', ical: 'ic', ful: '', ness: '',
};

const c = '[^aeiou]';          // consonant
const v = '[aeiouy]';          // vowel
const C = c + '[^aeiouy]*';    // consonant sequence
const V = v + '[aeiou]*';      // vowel sequence

const mgr0 = '^(' + C + ')?' + V + C;                     // [C]VC... is m>0
const meq1 = '^(' + C + ')?' + V + C + '(' + V + ')?$';   // [C]VC[V] is m=1
const mgr1 = '^(' + C + ')?' + V + C + V + C;             // [C]VCVC... is m>1
const sV = '^(' + C + ')?' + v;                           // vowel in stem

export function stem(input: string): string {
  let w = input.toLowerCase();
  if (w.length < 3) return w;

  const firstch = w.substring(0, 1);
  if (firstch === 'y') {
    w = firstch.toUpperCase() + w.substring(1);
  }

  let re: RegExp;
  let re2: RegExp;
  let re3: RegExp;
  let re4: RegExp;
  let fp: RegExpExecArray | null;

  // Step 1a
  re = /^(.+?)(ss|i)es$/;
  re2 = /^(.+?)([^s])s$/;
  if (re.test(w)) {
    w = w.replace(re, '$1$2');
  } else if (re2.test(w)) {
    w = w.replace(re2, '$1$2');
  }

  // Step 1b
  re = /^(.+?)eed$/;
  re2 = /^(.+?)(ed|ing)$/;
  if ((fp = re.exec(w)) !== null) {
    re = new RegExp(mgr0);
    if (re.test(fp[1])) {
      w = w.replace(/.$/, '');
    }
  } else if ((fp = re2.exec(w)) !== null) {
    const stemPart = fp[1];
    re2 = new RegExp(sV);
    if (re2.test(stemPart)) {
      w = stemPart;
      re2 = /(at|bl|iz)$/;
      re3 = new RegExp('([^aeiouylsz])\\1$');
      re4 = new RegExp('^' + C + v + '[^aeiouwxy]$');
      if (re2.test(w)) {
        w = w + 'e';
      } else if (re3.test(w)) {
        w = w.replace(/.$/, '');
      } else if (re4.test(w)) {
        w = w + 'e';
      }
    }
  }

  // Step 1c
  re = /^(.+?)y$/;
  if ((fp = re.exec(w)) !== null) {
    const stemPart = fp[1];
    re = new RegExp(sV);
    if (re.test(stemPart)) {
      w = stemPart + 'i';
    }
  }

  // Step 2
  re = /^(.+?)(ational|tional|enci|anci|izer|bli|alli|entli|eli|ousli|ization|ation|ator|alism|iveness|fulness|ousness|aliti|iviti|biliti|logi)$/;
  if ((fp = re.exec(w)) !== null) {
    const stemPart = fp[1];
    const suffix = fp[2];
    re = new RegExp(mgr0);
    if (re.test(stemPart)) {
      w = stemPart + step2list[suffix];
    }
  }

  // Step 3
  re = /^(.+?)(icate|ative|alize|iciti|ical|ful|ness)$/;
  if ((fp = re.exec(w)) !== null) {
    const stemPart = fp[1];
    const suffix = fp[2];
    re = new RegExp(mgr0);
    if (re.test(stemPart)) {
      w = stemPart + step3list[suffix];
    }
  }

  // Step 4
  re = /^(.+?)(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/;
  re2 = /^(.+?)(s|t)(ion)$/;
  if ((fp = re.exec(w)) !== null) {
    const stemPart = fp[1];
    re = new RegExp(mgr1);
    if (re.test(stemPart)) {
      w = stemPart;
    }
  } else if ((fp = re2.exec(w)) !== null) {
    const stemPart = fp[1] + fp[2];
    re2 = new RegExp(mgr1);
    if (re2.test(stemPart)) {
      w = stemPart;
    }
  }

  // Step 5a
  re = /^(.+?)e$/;
  if ((fp = re.exec(w)) !== null) {
    const stemPart = fp[1];
    re = new RegExp(mgr1);
    re2 = new RegExp(meq1);
    re3 = new RegExp('^' + C + v + '[^aeiouwxy]$');
    if (re.test(stemPart) || (re2.test(stemPart) && !re3.test(stemPart))) {
      w = stemPart;
    }
  }

  // Step 5b
  re = /ll$/;
  re2 = new RegExp(mgr1);
  if (re.test(w) && re2.test(w)) {
    w = w.replace(/.$/, '');
  }

  if (firstch === 'y') {
    w = firstch.toLowerCase() + w.substring(1);
  }

  return w;
}
