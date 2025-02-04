'use client';

import { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { VideoRecorder } from '@/components/feed/VideoRecorder';
import { ChevronLeft, Search } from 'lucide-react';
import { db, storage } from '@/lib/firebase';
import { collection, getDocs, addDoc, serverTimestamp } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL, uploadBytesResumable } from 'firebase/storage';
import { useAuth } from '@/lib/context/auth-context';
import { getLocationFromCoordinates } from '@/lib/google-maps';

interface Spot {
  id: string;
  title: string;
  location: string;
  spotType: string;
  position: {
    lat: number;
    lng: number;
  };
}

type Step = 'recording' | 'spot-selection';

async function compressVideo(videoBlob: Blob): Promise<Blob> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    video.src = URL.createObjectURL(videoBlob);
    video.onloadedmetadata = () => {
      // Set dimensions maintaining aspect ratio
      const width = 720; // target width
      const height = (video.videoHeight / video.videoWidth) * width;
      
      canvas.width = width;
      canvas.height = height;
      
      video.currentTime = 0;
      video.play();
      
      const mediaRecorder = new MediaRecorder(canvas.captureStream(), {
        mimeType: 'video/webm;codecs=h264',
        videoBitsPerSecond: 2500000 // 2.5 Mbps
      });
      
      const chunks: Blob[] = [];
      mediaRecorder.ondataavailable = (e) => chunks.push(e.data);
      mediaRecorder.onstop = () => resolve(new Blob(chunks, { type: 'video/mp4' }));
      
      mediaRecorder.start();
      
      const processFrame = () => {
        if (video.ended) {
          mediaRecorder.stop();
          return;
        }
        ctx?.drawImage(video, 0, 0, width, height);
        requestAnimationFrame(processFrame);
      };
      
      processFrame();
    };
  });
}

const NewPostPage = () => {
  const { user } = useAuth();
  const router = useRouter();
  const [step, setStep] = useState<Step>('recording');
  const [videoBlob, setVideoBlob] = useState<Blob | null>(null);
  const [selectedSpot, setSelectedSpot] = useState<Spot | null>(null);
  const [trick, setTrick] = useState('');
  const [spots, setSpots] = useState<Spot[]>([]);
  const [filteredSpots, setFilteredSpots] = useState<Spot[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSharing, setIsSharing] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);

  // Fetch spots when component mounts
  useEffect(() => {
    const fetchSpots = async () => {
      if (!user) return;
      
      try {
        const spots: Spot[] = [];
        
        // Get global spots
        const globalSpotsSnapshot = await getDocs(collection(db, 'globalSpots'));
        
        // Use Promise.all to fetch all locations concurrently
        const globalSpots = await Promise.all(
          globalSpotsSnapshot.docs.map(async (doc) => {
            const data = doc.data();
            let location = data.location;
            
            // If no location stored, get it from coordinates
            if (!location && data.position) {
              location = await getLocationFromCoordinates(
                data.position.lat,
                data.position.lng
              );
            }
            
            return {
              id: doc.id,
              title: data.title,
              location,
              spotType: data.spotType || 'Uncategorized',
              position: data.position
            };
          })
        );
        
        spots.push(...globalSpots);

        // Do the same for user spots
        const userSpotsSnapshot = await getDocs(collection(db, `users/${user.uid}/spots`));
        
        const userSpots = await Promise.all(
          userSpotsSnapshot.docs.map(async (doc) => {
            const data = doc.data();
            let location = data.location;
            
            if (!location && data.position) {
              location = await getLocationFromCoordinates(
                data.position.lat,
                data.position.lng
              );
            }
            
            return {
              id: doc.id,
              title: data.title,
              location,
              spotType: data.spotType || 'Uncategorized',
              position: data.position
            };
          })
        );
        
        spots.push(...userSpots);
        setSpots(spots);
        
      } catch (error) {
        console.error('Error fetching spots:', error);
      }
    };

    fetchSpots();
  }, [user]);

  // Filter spots based on search query
  const handleSearch = (query: string) => {
    setSearchQuery(query);
    if (!query.trim()) {
      setFilteredSpots([]);
      return;
    }

    const filtered = spots.filter(spot => 
      spot.title.toLowerCase().includes(query.toLowerCase()) ||
      spot.location?.toLowerCase().includes(query.toLowerCase()) ||
      spot.spotType?.toLowerCase().includes(query.toLowerCase())
    );
    setFilteredSpots(filtered);
  };

  const handleClose = useCallback(() => {
    router.back();
  }, [router]);

  const handleVideoRecorded = useCallback((blob: Blob) => {
    setVideoBlob(blob);
    setStep('spot-selection');
  }, []);

  const handleShare = useCallback(async () => {
    if (!selectedSpot || !videoBlob || !trick.trim() || !user) {
      console.log('Missing required fields:', { 
        hasSpot: !!selectedSpot, 
        hasVideo: !!videoBlob, 
        hasTrick: !!trick.trim(), 
        hasUser: !!user 
      });
      return;
    }

    setIsSharing(true);
    setShareError(null);

    try {
      console.log('Compressing video...');
      const compressedVideo = await compressVideo(videoBlob);
      console.log('Video compressed:', {
        originalSize: videoBlob.size / 1024 / 1024, // MB
        compressedSize: compressedVideo.size / 1024 / 1024 // MB
      });

      console.log('Starting video upload...');
      const videoRef = ref(storage, `videos/${user.uid}/${Date.now()}.mp4`);
      console.log('Uploading video to:', videoRef.fullPath);
      
      const uploadTask = uploadBytesResumable(videoRef, compressedVideo);
      
      uploadTask.on(
        'state_changed',
        (snapshot) => {
          const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
          console.log('Upload progress:', progress + '%');
        },
        (error) => {
          console.error('Upload error:', error);
          setShareError('Error uploading video: ' + error.message);
        }
      );

      await uploadTask;
      console.log('Video upload complete');

      const videoUrl = await getDownloadURL(videoRef);
      console.log('Video URL obtained');

      console.log('Creating post document...');
      const postData = {
        user: {
          id: user.uid,
          name: user.displayName || 'Anonymous',
          username: user.email?.split('@')[0] || 'anonymous',
          avatar: user.photoURL
        },
        spot: {
          id: selectedSpot.id,
          name: selectedSpot.title,
          location: selectedSpot.location
        },
        video: {
          url: videoUrl
        },
        trick: trick.trim(),
        likes: 0,
        timestamp: serverTimestamp(),
        createdAt: serverTimestamp()
      };

      console.log('Post data:', postData);
      await addDoc(collection(db, 'posts'), postData);

      router.push('/feed');
      
    } catch (error) {
      console.error('Error sharing post:', error);
      if (error instanceof Error) {
        setShareError(`Failed to share post: ${error.message}`);
      } else {
        setShareError('Failed to share post. Please try again.');
      }
    } finally {
      setIsSharing(false);
    }
  }, [videoBlob, selectedSpot, trick, user, router]);

  // Add a helper function to capitalize spot types
  const capitalizeSpotType = (spotType: string) => {
    return spotType.charAt(0).toUpperCase() + spotType.slice(1);
  };

  return (
    <div 
      className="absolute inset-0 bg-black" 
      style={{ 
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        overflow: 'hidden'
      }}
    >
      {step === 'recording' ? (
        <VideoRecorder
          onClose={handleClose}
          onVideoRecorded={handleVideoRecorded}
        />
      ) : (
        <div className="flex flex-col h-full">
          {/* Header */}
          <div className="bg-black">
            <div className="flex items-center justify-between px-4 h-[65px]">
              <button
                onClick={() => setStep('recording')}
                className="text-white hover:text-zinc-300 transition-colors"
              >
                <ChevronLeft className="h-6 w-6" />
              </button>
              <h1 className="text-lg font-medium text-white">New Post</h1>
              <div className="w-6" />
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 px-4">
            {/* Video Thumbnail - Updated size */}
            <div className="w-[220px] h-[220px] rounded-2xl overflow-hidden bg-zinc-900 mb-8">
              {videoBlob && (
                <video 
                  src={URL.createObjectURL(videoBlob)} 
                  className="w-full h-full object-cover"
                />
              )}
            </div>

            {/* Search Spot */}
            <div className="space-y-2 mb-6 relative">
              <h2 className="text-lg font-medium">Search Spot</h2>
              <div className="relative flex items-center">
                <Search className="absolute left-4 w-5 h-5 text-zinc-400" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => handleSearch(e.target.value)}
                  placeholder="Choose the spot you skated"
                  className="w-full h-14 pl-12 pr-4 rounded-full bg-white/[0.04] hover:bg-white/[0.08] 
                            border border-[#2E2E2E] focus:border-[#3E3E45] focus:bg-white/[0.08]
                            text-white placeholder:text-zinc-400 outline-none transition-colors"
                />
              </div>

              {/* Search Results */}
              {searchQuery && filteredSpots.length > 0 && (
                <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-50">
                  <div className="bg-[#121212] rounded-2xl shadow-lg overflow-hidden">
                    <div className="max-h-[240px] overflow-y-auto">
                      {filteredSpots.slice(0, 6).map((spot) => (
                        <button
                          key={spot.id}
                          onClick={() => {
                            setSelectedSpot(spot);
                            setSearchQuery(spot.title);
                            setFilteredSpots([]);
                          }}
                          className="w-full px-4 py-3 text-left hover:bg-white/[0.08] transition-colors"
                        >
                          <div className="flex flex-col gap-0.5">
                            <p className="font-medium text-white">{spot.title}</p>
                            <div className="flex items-center gap-2 text-sm text-zinc-400">
                              <span>{capitalizeSpotType(spot.spotType)}</span>
                              {spot.location && (
                                <>
                                  <span>•</span>
                                  <span>{spot.location}</span>
                                </>
                              )}
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Name Your Trick */}
            <div className="space-y-2">
              <h2 className="text-lg font-medium">Name Your Trick</h2>
              <div className="relative flex items-center">
                <input
                  type="text"
                  value={trick}
                  onChange={(e) => setTrick(e.target.value)}
                  placeholder="Name or select your trick"
                  className="w-full h-14 px-4 rounded-full bg-white/[0.04] hover:bg-white/[0.08]
                            border border-[#2E2E2E] focus:border-[#3E3E45] focus:bg-white/[0.08]
                            text-white placeholder:text-zinc-400 outline-none transition-colors"
                />
              </div>
            </div>
          </div>

          {/* Share Button - Fixed at bottom */}
          <div className="p-4 mt-auto">
            {shareError && (
              <p className="text-red-500 text-sm mb-2 text-center">{shareError}</p>
            )}
            <button
              onClick={handleShare}
              disabled={!selectedSpot || !trick.trim() || isSharing}
              className={`w-full h-12 rounded-full font-medium transition-colors relative ${
                selectedSpot && trick.trim() && !isSharing
                  ? 'bg-[#a3ff12] hover:bg-[#92e610] text-black'
                  : 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
              }`}
            >
              {isSharing ? (
                <>
                  <span className="opacity-0">Share</span>
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="w-5 h-5 border-2 border-black border-t-transparent rounded-full animate-spin" />
                  </div>
                </>
              ) : (
                'Share'
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default NewPostPage; 