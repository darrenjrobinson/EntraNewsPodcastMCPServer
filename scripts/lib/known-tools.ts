/**
 * Curated list of community tools for tool-mention extraction.
 *
 * Podcast transcripts contain no hyperlinks (unlike the newsletter siblings,
 * which extract GitHub hrefs), so mentions are matched against this alias
 * list. The find_tool_mentions handler keeps a transcript-text fallback, so
 * tools missing from this list remain discoverable — the list is low-stakes
 * and can grow over time.
 */

export interface KnownTool {
  name: string;
  aliases: string[];
}

export const KNOWN_TOOLS: KnownTool[] = [
  { name: 'Maester', aliases: ['maester'] },
  { name: 'Lokka', aliases: ['lokka'] },
  { name: 'EntraExporter', aliases: ['entra exporter', 'entraexporter'] },
  { name: 'idPowerToys', aliases: ['id power toys', 'idpowertoys', 'id powertoys'] },
  { name: 'Graph X-Ray', aliases: ['graph x-ray', 'graph xray', 'graph x ray'] },
  { name: 'MSIdentityTools', aliases: ['ms identity tools', 'msidentitytools'] },
  { name: 'AzureADAssessment', aliases: ['azure ad assessment', 'azureadassessment'] },
  { name: 'EntraFalcon', aliases: ['entra falcon', 'entrafalcon'] },
  { name: 'ROADtools', aliases: ['roadtools', 'road tools', 'roadrecon'] },
  { name: 'AADInternals', aliases: ['aad internals', 'aadinternals'] },
  { name: 'GraphRunner', aliases: ['graph runner', 'graphrunner'] },
  { name: 'Microsoft Graph PowerShell SDK', aliases: ['graph powershell', 'microsoft graph powershell'] },
  { name: 'Entra PowerShell', aliases: ['entra powershell', 'entra power shell'] },
  { name: 'Graph Explorer', aliases: ['graph explorer'] },
  { name: 'Conditional Access Gallery', aliases: ['conditional access gallery'] },
  { name: 'CA Optics', aliases: ['ca optics', 'caoptics'] },
  { name: 'Entra.News', aliases: ['entra news', 'entra dot news', 'entra.news'] },
  { name: 'Entra.Chat', aliases: ['entra chat', 'entra dot chat', 'entra.chat'] },
  { name: 'cmd.ms', aliases: ['cmd.ms', 'cmd dot ms'] },
  { name: 'aka.ms', aliases: ['aka.ms', 'aka dot ms'] },
  { name: 'Zero Trust Assessment', aliases: ['zero trust assessment', 'zt assessment'] },
  { name: 'Entra ID Governance', aliases: ['entitlement management', 'access packages', 'lifecycle workflows'] },
  { name: 'PIM', aliases: ['privileged identity management', 'pim for groups'] },
  { name: 'Defender for Identity', aliases: ['defender for identity', 'mdi'] },
  { name: 'BloodHound', aliases: ['bloodhound', 'blood hound', 'azurehound'] },
  { name: 'Evilginx', aliases: ['evilginx', 'evil ginx', 'evil jinx'] },
  { name: 'CA Insight', aliases: ['ca insight', 'cainsight'] },
  { name: 'AZTier', aliases: ['aztier', 'az tier'] },
  { name: 'Entra ID Attack and Defense Playbook', aliases: ['attack and defense playbook'] },
  { name: 'PingCastle', aliases: ['ping castle', 'pingcastle'] },
  { name: 'ADConnectDump', aliases: ['ad connect dump', 'adconnectdump'] },
  { name: 'Hybrid Identity', aliases: ['entra connect', 'azure ad connect', 'cloud sync'] },
  { name: 'DSRegTool', aliases: ['dsregtool', 'dsreg tool'] },
  { name: 'ECMA2Host', aliases: ['ecma2host', 'ecma2 host', 'ecma connector host'] },
];
