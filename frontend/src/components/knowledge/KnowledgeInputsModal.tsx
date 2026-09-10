import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Dialog,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DialogScrollBody,
  DialogScrollContent,
  DialogScrollHeader,
} from '@/components/ui/dialog-scroll';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Plus, Trash2, RefreshCw, FileText, Link, Type, Loader2, Upload, X, AlertCircle, Info } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { knowledgeInputTypes } from '@/data/knowledge';
import type { KnowledgeInputDoc, KnowledgeInputType } from '@/types/knowledge.types';
import {
  getKnowledgeInputs,
  createKnowledgeInput,
  deleteKnowledgeInput,
  reprocessInput,
} from '@/services/knowledgeApi';
import { file as frappeFile } from '@/lib/frappe-sdk';

interface QueuedUpload {
  id: string;
  fileName: string;
  progress: number;
  status: 'uploading' | 'creating' | 'error';
  error?: string;
}

const INPUTS_POLL_INTERVAL_MS = 4000;

const SETTLED_INPUT_STATUSES: ReadonlySet<string> = new Set(['Indexed', 'Error']);

function hasUnsettledInput(list: KnowledgeInputDoc[]): boolean {
  return list.some((input) => !SETTLED_INPUT_STATUSES.has(input.status));
}

interface KnowledgeInputsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  knowledgeSource: string;
  onSourceChanged: () => void;
}

function getInputStatusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'success' | 'outline' {
  switch (status) {
    case 'Indexed':
      return 'success';
    case 'Processing':
      return 'outline';
    case 'Error':
      return 'destructive';
    default:
      return 'secondary';
  }
}

function getInputIcon(type: KnowledgeInputType) {
  switch (type) {
    case 'File':
      return FileText;
    case 'URL':
      return Link;
    case 'Text':
      return Type;
  }
}

function getInputPreview(input: KnowledgeInputDoc): string {
  switch (input.input_type) {
    case 'File':
      return input.file_name || input.file || 'No file';
    case 'URL':
      return input.url || 'No URL';
    case 'Text':
      return input.text?.slice(0, 80) || 'No text';
    default:
      return '';
  }
}

export function KnowledgeInputsModal({
  open,
  onOpenChange,
  knowledgeSource,
  onSourceChanged,
}: KnowledgeInputsModalProps) {
  const [inputs, setInputs] = useState<KnowledgeInputDoc[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [uploadQueue, setUploadQueue] = useState<QueuedUpload[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [closeGuardOpen, setCloseGuardOpen] = useState(false);
  const inputsRef = useRef<KnowledgeInputDoc[]>([]);
  inputsRef.current = inputs;

  const uploading = uploadQueue.some((item) => item.status === 'uploading' || item.status === 'creating');

  // Create form state
  const [inputType, setInputType] = useState<KnowledgeInputType>('File');
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadInputs = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getKnowledgeInputs(knowledgeSource);
      setInputs(data);
    } catch {
      toast.error('Failed to load knowledge inputs');
    } finally {
      setLoading(false);
    }
  }, [knowledgeSource]);

  useEffect(() => {
    if (open && knowledgeSource) {
      loadInputs();
    }
  }, [open, knowledgeSource, loadInputs]);

  // Poll the inputs list while anything is still Pending/Processing so
  // status badges (and the "safe to close" banner) settle on their own,
  // mirroring the fallback-polling approach in useRunStatusPolling.
  useEffect(() => {
    if (!open || !knowledgeSource) return;
    if (!hasUnsettledInput(inputsRef.current)) return;

    let cancelled = false;
    const intervalId = setInterval(async () => {
      if (cancelled) return;
      try {
        const data = await getKnowledgeInputs(knowledgeSource);
        if (cancelled) return;
        setInputs(data);
        if (!hasUnsettledInput(data)) {
          onSourceChanged();
        }
      } catch (error) {
        // A failed poll must not kill the fallback; the next tick retries.
        console.error('Error polling knowledge inputs:', error);
      }
    }, INPUTS_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, knowledgeSource, inputs, onSourceChanged]);

  const resetForm = () => {
    setInputType('File');
    setText('');
    setUrl('');
    setShowCreate(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const uploadOneFile = useCallback(
    async (file: File) => {
      const id = `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setUploadQueue((q) => [...q, { id, fileName: file.name, progress: 0, status: 'uploading' }]);
      try {
        const response = await frappeFile.uploadFile(
          file,
          {
            isPrivate: true,
            doctype: 'Knowledge Input',
          },
          (completed, total) => {
            if (total) {
              const progress = Math.round((completed / total) * 100);
              setUploadQueue((q) => q.map((item) => (item.id === id ? { ...item, progress } : item)));
            }
          },
        );
        const res = response as { data?: { message?: { file_url?: string } } };
        const fileUrl = res?.data?.message?.file_url;
        if (!fileUrl) throw new Error('No file URL returned');

        setUploadQueue((q) => q.map((item) => (item.id === id ? { ...item, status: 'creating' } : item)));
        await createKnowledgeInput({
          knowledge_source: knowledgeSource,
          input_type: 'File',
          file: fileUrl,
        });
        setUploadQueue((q) => q.filter((item) => item.id !== id));
        await loadInputs();
        onSourceChanged();
      } catch {
        setUploadQueue((q) =>
          q.map((item) => (item.id === id ? { ...item, status: 'error', error: 'Upload failed' } : item)),
        );
        toast.error(`Failed to upload ${file.name}`);
      }
    },
    [knowledgeSource, loadInputs, onSourceChanged],
  );

  const handleFilesSelected = useCallback(
    (files: FileList | File[] | null) => {
      if (!files || files.length === 0) return;
      Array.from(files).forEach((file) => {
        void uploadOneFile(file);
      });
    },
    [uploadOneFile],
  );

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleFilesSelected(e.target.files);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleDropzoneDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    handleFilesSelected(e.dataTransfer.files);
  };

  const dismissQueuedUpload = (id: string) => {
    setUploadQueue((q) => q.filter((item) => item.id !== id));
  };

  const handleCreate = async () => {
    const data: Partial<KnowledgeInputDoc> = {
      knowledge_source: knowledgeSource,
      input_type: inputType,
    };

    if (inputType === 'Text' && !text.trim()) {
      toast.error('Text content is required');
      return;
    }
    if (inputType === 'URL' && !url.trim()) {
      toast.error('URL is required');
      return;
    }

    if (inputType === 'Text') data.text = text;
    if (inputType === 'URL') data.url = url;

    setCreating(true);
    try {
      await createKnowledgeInput(data);
      toast.success('Knowledge input created');
      resetForm();
      await loadInputs();
      onSourceChanged();
    } catch {
      toast.error('Failed to create knowledge input');
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteConfirmed = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteKnowledgeInput(deleteTarget);
      toast.success('Knowledge input deleted');
      setDeleteTarget(null);
      await loadInputs();
      onSourceChanged();
    } catch {
      toast.error('Failed to delete knowledge input');
    } finally {
      setDeleting(false);
    }
  };

  const handleModalOpenChange = (next: boolean) => {
    if (!next && uploading) {
      setCloseGuardOpen(true);
      return;
    }
    onOpenChange(next);
  };

  const confirmCloseWhileUploading = () => {
    setCloseGuardOpen(false);
    onOpenChange(false);
  };

  const handleReprocess = async (name: string) => {
    try {
      await reprocessInput(name);
      toast.success('Reprocessing started');
      await loadInputs();
      onSourceChanged();
    } catch {
      toast.error('Failed to reprocess knowledge input');
    }
  };

  const hasProcessingInput = inputs.some((input) => input.status === 'Processing' || input.status === 'Pending');

  return (
    <Dialog open={open} onOpenChange={handleModalOpenChange}>
      <DialogScrollContent className="max-w-2xl">
        <DialogScrollHeader>
          <DialogTitle>Knowledge inputs</DialogTitle>
          <DialogDescription>
            Manage content inputs for this knowledge source
          </DialogDescription>
        </DialogScrollHeader>

        <DialogScrollBody className="space-y-4 py-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <p className="text-sm text-steel">
                {inputs.length} {inputs.length === 1 ? 'input' : 'inputs'}
              </p>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => void loadInputs()}
                disabled={loading}
                title="Refresh"
              >
                <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
              </Button>
            </div>
            <Button
              size="sm"
              variant={showCreate ? 'secondary' : 'default'}
              onClick={() => setShowCreate(!showCreate)}
            >
              <Plus className="w-4 h-4 mr-2" />
              New input
            </Button>
          </div>

          {hasProcessingInput && (
            <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-2.5 text-xs text-steel-soft">
              <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <p>
                Indexing runs in the background. Once your files finish uploading, it&apos;s safe to close
                this dialog or navigate away — processing will continue.
              </p>
            </div>
          )}

          {showCreate && (
            <div className="rounded-lg border p-4 space-y-4">
              <div className="space-y-2">
                <Label>Input type</Label>
                <Select value={inputType} onValueChange={(v) => setInputType(v as KnowledgeInputType)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {knowledgeInputTypes.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {inputType === 'File' && (
                <div className="space-y-3">
                  <Label>Files</Label>
                  <div
                    className={cn(
                      'flex flex-col items-center justify-center gap-2 rounded-md border border-dashed p-6 text-center transition-colors cursor-pointer',
                      dragOver ? 'border-primary bg-primary/5' : 'border-input',
                    )}
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOver(true);
                    }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={handleDropzoneDrop}
                  >
                    <Upload className="w-6 h-6 text-steel-soft" />
                    <p className="text-sm">Drag and drop files here, or click to browse</p>
                    <p className="text-xs text-steel-soft">Select multiple files to upload them all at once</p>
                    <Input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      onChange={handleFileInputChange}
                      className="hidden"
                    />
                  </div>

                  {uploadQueue.length > 0 && (
                    <div className="space-y-2">
                      {uploadQueue.map((item) => (
                        <div key={item.id} className="flex items-center gap-3 rounded-md border p-2.5">
                          {item.status === 'error' ? (
                            <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0" />
                          ) : (
                            <Loader2 className="w-4 h-4 animate-spin text-steel-soft flex-shrink-0" />
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="text-sm truncate">{item.fileName}</p>
                            {item.status === 'error' ? (
                              <p className="text-xs text-destructive">{item.error}</p>
                            ) : (
                              <>
                                <p className="text-xs text-steel-soft">
                                  {item.status === 'uploading' ? `Uploading... ${item.progress}%` : 'Creating input...'}
                                </p>
                                <Progress value={item.status === 'uploading' ? item.progress : 100} className="h-1 mt-1" />
                              </>
                            )}
                          </div>
                          {item.status === 'error' && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => dismissQueuedUpload(item.id)}
                            >
                              <X className="w-3.5 h-3.5" />
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {inputType === 'Text' && (
                <div className="space-y-2">
                  <Label>Text content</Label>
                  <Textarea
                    placeholder="Paste text content here..."
                    className="min-h-[120px] resize-y"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                  />
                </div>
              )}

              {inputType === 'URL' && (
                <div className="space-y-2">
                  <Label>URL</Label>
                  <Input
                    placeholder="https://example.com/docs"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                  />
                </div>
              )}

              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={resetForm}>
                  {inputType === 'File' ? 'Done' : 'Cancel'}
                </Button>
                {inputType !== 'File' && (
                  <Button size="sm" onClick={handleCreate} disabled={creating}>
                    {creating && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                    Create
                  </Button>
                )}
              </div>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-steel-soft" />
            </div>
          ) : inputs.length === 0 ? (
            <div className="text-center py-8 font-body text-steel text-sm">
              No knowledge inputs yet. Add one to get started.
            </div>
          ) : (
            <div className="space-y-2">
              {inputs.map((input) => {
                const Icon = getInputIcon(input.input_type);
                return (
                  <div
                    key={input.name}
                    className="flex items-center gap-3 rounded-md border p-3"
                  >
                    <Icon className="w-4 h-4 text-steel-soft flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">
                        {getInputPreview(input)}
                      </p>
                      <div className="flex items-center gap-2 mt-1">
                        <Badge variant={getInputStatusVariant(input.status)} size="sm">
                          {input.status}
                        </Badge>
                        {input.chunks_created > 0 && (
                          <span className="text-xs text-steel-soft">
                            {input.chunks_created} chunks
                          </span>
                        )}
                        {input.error_message && (
                          <span className="text-xs text-destructive truncate max-w-[200px]">
                            {input.error_message}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => handleReprocess(input.name)}
                        title="Reprocess"
                        disabled={input.status === 'Pending' || input.status === 'Processing'}
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${input.status === 'Processing' ? 'animate-spin' : ''}`} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setDeleteTarget(input.name)}
                        title="Delete"
                        className="text-destructive hover:text-destructive"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </DialogScrollBody>
      </DialogScrollContent>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(next) => { if (!next && !deleting) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this input?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove the input and any chunks indexed from it. This action cannot
              be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleDeleteConfirmed();
              }}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={closeGuardOpen} onOpenChange={setCloseGuardOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel upload in progress?</AlertDialogTitle>
            <AlertDialogDescription>
              A file is still uploading. Closing this dialog now will interrupt the upload before it
              finishes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep uploading</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                confirmCloseWhileUploading();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Cancel upload and close
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
