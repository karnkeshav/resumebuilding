// full-file: src/keywords.js
function normalize(text) {
  return (text || '').toLowerCase();
}

function matchKeywords(jobDescription, resume) {
  const jd = normalize(jobDescription);
  const skills = (resume.skills || []).map(s => s.toLowerCase());
  const matched = [];
  const partial = [];
  const missing = [];
  const matchedBullets = [];

  for (const skill of skills) {
    if (jd.includes(skill)) matched.push(skill);
    else {
      // partial match: check word stems or short tokens
      const token = skill.split(/[\s\/\.-]+/)[0];
      if (token && jd.includes(token) && skill.length > 3) partial.push(skill);
      else missing.push(skill);
    }
  }

  // find bullets that contain matched skills
  (resume.experience || []).forEach(exp => {
    (exp.bullets || []).forEach(b => {
      const low = b.toLowerCase();
      for (const m of matched.concat(partial)) {
        if (low.includes(m.split(' ')[0])) {
          if (!matchedBullets.includes(b)) matchedBullets.push(b);
        }
      }
    });
  });

  // compute simple score
  const score = Math.round((matched.length / (skills.length || 1)) * 100);

  return {
    score,
    matched,
    partial,
    missing,
    matchedBullets
  };
}

module.exports = { matchKeywords };
