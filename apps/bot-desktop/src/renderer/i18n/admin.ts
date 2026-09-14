import { useContext } from 'react'
import { LocaleContext } from './index'
const translations: Record<string, string> = {
  'HOST CONSOLE · LAB': 'ADMINISTRAÇÃO · LAB',
  'Adicionar outro computador': 'Adicionar outro computador',
  'SSH configuration alias': 'Alias da configuração SSH',
  'Connect using an alias from your SSH configuration. The host key must already be trusted.':
    'Use um alias da sua configuração SSH. A chave do computador já deve ser confiável.',
  Disconnect: 'Desconectar',
  Connect: 'Conectar',
  Reconnect: 'Reconectar',
  Connected: 'Conectado',
  Disconnected: 'Desconectado',
  'YOUR COMPUTE, CLOSE AT HAND': 'SEUS COMPUTADORES',
  'A place for your machines.': 'Computadores',
  'Connect a host to inspect capacity and manage virtual machines.':
    'Conecte um computador para consultar a capacidade e administrar suas máquinas virtuais.',
  'Diagnose & refresh': 'Diagnosticar e atualizar',
  'Retry same request': 'Repetir a mesma solicitação',
  'Disconnected · displayed state is stale. Reconnect before making changes.':
    'Sem conexão · o estado exibido está desatualizado. Reconecte antes de fazer alterações.',
  'Your hosts. Your workloads.': 'Seus computadores e suas tarefas.',
  'Add an SSH alias on the left to bring your machines into view.':
    'Adicione um alias SSH à esquerda para ver seus computadores.',
  'Virtual machines': 'Máquinas virtuais',
  'Create VM': 'Criar máquina virtual',
  'Observed:': 'Observado:',
  'Desired:': 'Desejado:',
  '· Health:': '· Saúde:',
  'No VMs yet. Create one from an available image.':
    'Nenhuma máquina virtual. Crie uma a partir de uma imagem disponível.',
  Operation: 'Operação',
  'Request accepted. Waiting for the host to finish.': 'Solicitação recebida. Aguardando a conclusão pelo Host.',
  'Cancel operation': 'Cancelar operação',
  'Close details': 'Fechar detalhes',
  Start: 'Iniciar',
  'Shut down': 'Desligar',
  Restart: 'Reiniciar',
  'Purge retained disk': 'Excluir disco retido',
  'Remove VM': 'Remover máquina virtual',
  'Removed ·': 'Removida ·',
  'Disk data retained and counted in host storage allocation.':
    'Dados do disco mantidos e contabilizados no armazenamento do Host.',
  'Disk data deleted.': 'Dados do disco excluídos.',
  'Read recent boot log': 'Ler registro de inicialização',
  'Recent guest boot log': 'Registro recente de inicialização',
  'No new console output.': 'Nenhuma nova saída do console.',
  'Health & inspection': 'Saúde e inspeção',
  'Events & logs': 'Eventos e registros',
  'Recent host events and diagnostic output.': 'Eventos recentes do Host e saída de diagnóstico.',
  Remove: 'Remover',
  'Remove this VM and retain its disk data by default. Check below to permanently delete its data.':
    'Remova esta máquina mantendo seus dados por padrão. Marque abaixo para excluir os dados permanentemente.',
  'Delete VM data permanently': 'Excluir dados permanentemente',
  Cancel: 'Cancelar',
  'Delete VM and data': 'Excluir máquina e dados',
  'Remove VM, retain data': 'Remover máquina, manter dados',
  'Create a virtual machine': 'Criar uma máquina virtual',
  Name: 'Nome',
  Image: 'Imagem',
  Runtime: 'Ambiente',
  'CPU cores': 'Núcleos de CPU',
  'Memory (MiB)': 'Memória (MiB)',
  'Disk (GiB)': 'Disco (GiB)',
  'Retained disks': 'Discos retidos',
  'Disks retained on this host. They remain included in host storage allocation.':
    'Discos mantidos neste Host. Continuam contabilizados na alocação de armazenamento.',
  'GiB · Inspect retained data': 'GiB · Inspecionar dados retidos',
  'Host resources': 'Recursos do Host',
  '· Observed memory': '· Memória observada',
  'MiB · Capabilities:': 'MiB · Capacidades:',
  'Host supported': 'Host compatível',
  'Host unsupported': 'Host incompatível',
  Memory: 'Memória',
  Storage: 'Armazenamento',
  cores: 'núcleos',
  ready: 'pronto',
  unavailable: 'indisponível',
  queued: 'na fila',
  running: 'em execução',
  succeeded: 'concluída',
  failed: 'falhou',
  cancelled: 'cancelada',
  stopped: 'desligada',
  removed: 'removida',
  starting: 'iniciando',
  stopping: 'desligando',
  healthy: 'saudável',
  unknown: 'desconhecida',
  degraded: 'degradada',
  'Host disconnected. Reconnect to refresh.': 'Host desconectado. Reconecte para atualizar.',
  'Operation outcome unavailable.': 'Resultado da operação indisponível.',
  'Host did not return an operation. Inspect before retrying.':
    'O Host não retornou uma operação. Inspecione antes de tentar novamente.',
  'Remove target': 'Remover computador',
  Service: 'Serviço',
  Protocol: 'Protocolo',
}
export function useAdminT() {
  const locale = useContext(LocaleContext)
  return (text: string) =>
    locale === 'pt-BR'
      ? (translations[text] ?? text)
      : text === 'Adicionar outro computador'
        ? 'Add another computer'
        : text
}
